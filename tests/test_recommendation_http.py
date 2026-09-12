"""Real local HTTP routes and temporary projects; no provider or model requests."""
import copy
import json
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener
from unittest.mock import Mock, patch

import server as app
import recommendation_jobs as recommendation
from test_workflow_restore import project_fixture, report_fixture


REPORT_ID = 'a' * 16
OTHER_REPORT_ID = 'b' * 16


class RecommendationHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = app.Store(self.temp.name)
        project = project_fixture()
        project['ai_reports'] = [report_fixture(project, 'insights', REPORT_ID)]
        self.project = self.store.save(project)
        other = project_fixture()
        other['name'] = '另一个独立项目'
        other['ai_reports'] = [report_fixture(other, 'insights', OTHER_REPORT_ID)]
        self.other = self.store.save(other)
        self.jobs = Mock()
        self.jobs.get.side_effect = self.cached
        self.jobs.ensure.side_effect = self.started
        self.jobs.is_running.return_value = False
        self.release_worker = threading.Event()
        self.real_jobs = None
        self.factory = patch.object(app, 'RecommendationJobs', return_value=self.jobs, create=True)
        self.factory.start()
        self.addCleanup(self.factory.stop)
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), app.handler_for(self.store))
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.http.server_port}'
        self.path = '/api/projects/' + self.project['id'] + '/recommendations'
        self.opener = build_opener(ProxyHandler({}))

    def tearDown(self):
        self.release_worker.set()
        if self.real_jobs:
            deadline = time.monotonic() + 5
            while self.real_jobs.is_running() and time.monotonic() < deadline:
                time.sleep(0.01)
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=5)
        self.temp.cleanup()

    @staticmethod
    def require_report(project, report_id):
        if not any(row['id'] == report_id for row in project['ai_reports']):
            raise ValueError('报告不属于当前项目')

    def cached(self, project, report_id):
        self.require_report(project, report_id)
        return next((copy.deepcopy(row) for row in project.get('product_recommendations', [])
                     if row['report_id'] == report_id), None)

    def started(self, project, report_id, retry=False):
        self.require_report(project, report_id)
        return {'id': 'c' * 16, 'report_id': report_id, 'status': 'running', 'phase': 'planning'}

    def request(self, path=None, body=None, *, method=None, origin=None,
                content_type='application/json', raw=None, host=None):
        headers = {'Content-Type': content_type}
        if origin is not None:
            headers['Origin'] = origin
        if host is not None:
            headers['Host'] = host
        payload = raw if raw is not None else json.dumps(body).encode() if body is not None else None
        request = Request(self.base + (path or self.path), data=payload,
                          headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def disk_state(self):
        return {str(path.relative_to(self.store.path)): path.read_bytes()
                for path in self.store.path.rglob('*.json')}

    def use_real_jobs(self, hold_plan=False):
        """Keep the actual worker, persistence and parser; replace external calls only."""
        self.worker_entered = threading.Event()

        def runner(system, payload, schema):
            if schema is recommendation.PLAN_SCHEMA:
                self.worker_entered.set()
                if hold_plan and not self.release_worker.wait(5):
                    raise ValueError('测试未释放推荐规划')
                return {'queries': [{'query': 'easy clean pet fountain',
                                     'direction': '便于拆洗的饮水机'}]}, {}
            product_id = payload['products'][0]['id']
            return {'title': '参考商品', 'direction': '便于拆洗的饮水机',
                'target': '关注清洗的养宠者', 'summary': '参考结构并验证维护体验',
                'recommended_product_id': product_id,
                'reasons': [{'text': '适合对照清洗需求进行样品验证', 'product_ids': [product_id],
                             'evidence_ids': [payload['evidence'][0]['id']]}],
                'alternatives': [], 'checks': ['验证清洗步骤和成本利润'], 'no_match_reason': ''}, {}

        self.model = Mock(side_effect=runner)
        self.query = Mock(return_value={'data': {'items': [{'asin': 'B000000001',
            'title': 'Easy clean pet fountain', 'price': 29.99, 'rating': 4.3,
            'ratings': 123, 'units': 100, 'month': '2026-08'}]}})
        self.real_jobs = recommendation.RecommendationJobs(self.store, app.LOCK, app.uid,
            app.now, app.import_rows, runner=self.model, query=self.query)
        self.jobs.get.side_effect = self.real_jobs.get
        self.jobs.ensure.side_effect = self.real_jobs.ensure
        self.jobs.is_running.side_effect = self.real_jobs.is_running
        return self.real_jobs

    def completed_record(self, report_id=REPORT_ID):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            status, record = self.request(self.path + '?report=' + report_id)
            self.assertEqual(status, 200)
            if record and record['status'] != 'running':
                return record
            time.sleep(0.01)
        self.fail('模拟推荐任务未在五秒内保存终态')

    def test_get_without_cache_is_read_only(self):
        before = self.disk_state()
        for _ in range(2):
            status, record = self.request(self.path + '?report=' + REPORT_ID)
            self.assertEqual(status, 200)
            self.assertIsNone(record)
        self.assertEqual(self.disk_state(), before)
        self.jobs.ensure.assert_not_called()
        self.assertEqual(self.jobs.get.call_count, 2)
        project, report_id = self.jobs.get.call_args.args
        self.assertEqual((project['id'], report_id), (self.project['id'], REPORT_ID))

    def test_get_returns_only_the_saved_cache_for_this_project(self):
        saved = self.store.load(self.project['id'])
        saved['product_recommendations'] = [{'id': 'd' * 16, 'report_id': REPORT_ID,
                                            'status': 'no_match', 'message': '未找到可验证商品'}]
        self.store.save(saved, saved['revision'])
        before = self.disk_state()
        status, record = self.request(self.path + '?report=' + REPORT_ID)
        self.assertEqual(status, 200)
        self.assertEqual(record, saved['product_recommendations'][0])
        self.assertEqual(self.disk_state(), before)
        self.jobs.ensure.assert_not_called()

    def test_get_rejects_malformed_report_ids_without_start_or_write(self):
        before = self.disk_state()
        for query in ('', '?report=../other', '?report=' + 'a' * 15):
            with self.subTest(query=query):
                self.assertEqual(self.request(self.path + query)[0], 400)
        self.jobs.get.assert_not_called()
        self.jobs.ensure.assert_not_called()
        self.assertEqual(self.disk_state(), before)

    def test_post_same_origin_delegates_the_current_project_and_explicit_retry(self):
        for body, retry in (({'report_id': REPORT_ID}, False),
                            ({'report_id': REPORT_ID, 'retry': False}, False),
                            ({'report_id': REPORT_ID, 'retry': True}, True)):
            status, record = self.request(body=body, origin=self.base)
            self.assertEqual(status, 202)
            self.assertEqual(record['report_id'], REPORT_ID)
            args, kwargs = self.jobs.ensure.call_args
            self.assertEqual(args[0]['id'], self.project['id'])
            self.assertEqual(args[0]['revision'], self.store.load(self.project['id'])['revision'])
            self.assertEqual(args[1], REPORT_ID)
            self.assertEqual(kwargs.get('retry', args[2] if len(args) > 2 else False), retry)

    def test_post_rejects_cross_origin_wrong_host_and_non_json_before_start(self):
        cases = [({'origin': 'https://untrusted.example'}, 403),
                 ({'host': 'untrusted.example'}, 403),
                 ({'content_type': 'text/plain'}, 415),
                 ({'content_type': 'application/x-www-form-urlencoded'}, 415)]
        before = self.disk_state()
        for options, expected in cases:
            with self.subTest(options=options):
                status, _ = self.request(body={'report_id': REPORT_ID}, **options)
                self.assertEqual(status, expected)
        self.jobs.ensure.assert_not_called()
        self.assertEqual(self.disk_state(), before)

    def test_post_rejects_malformed_ids_retry_and_json(self):
        before = self.disk_state()
        for body in ({}, {'report_id': '../other'}, {'report_id': 'a' * 15},
                     {'report_id': REPORT_ID, 'retry': 'false'},
                     {'report_id': REPORT_ID, 'retry': 1}, []):
            with self.subTest(body=body):
                self.assertEqual(self.request(body=body)[0], 400)
        self.assertEqual(self.request(method='POST', raw=b'{')[0], 400)
        self.jobs.ensure.assert_not_called()
        self.assertEqual(self.disk_state(), before)

    def test_busy_analysis_blocks_new_work_but_keeps_saved_results_readable(self):
        self.jobs.ai_busy = lambda: True
        before = self.disk_state()
        self.assertEqual(self.request(body={'report_id': REPORT_ID})[0], 409)
        self.jobs.ensure.assert_not_called()
        self.assertEqual(self.disk_state(), before)
        saved = self.store.load(self.project['id'])
        record = {'id': 'd' * 16, 'report_id': REPORT_ID, 'status': 'failed'}
        saved['product_recommendations'] = [record]
        self.store.save(saved, saved['revision'])
        self.jobs.ensure.side_effect = lambda project, report_id, retry=False: self.cached(project, report_id)
        before = self.disk_state()
        self.assertEqual(self.request(body={'report_id': REPORT_ID}), (202, record))
        self.jobs.ensure.reset_mock()
        self.assertEqual(self.request(body={'report_id': REPORT_ID, 'retry': True})[0], 409)
        self.jobs.ensure.assert_not_called()
        self.assertEqual(self.request(self.path + '?report=' + REPORT_ID), (200, record))
        self.assertEqual(self.disk_state(), before)

    def test_other_projects_report_cannot_be_read_or_started_here(self):
        before = self.disk_state()
        self.assertEqual(self.request(self.path + '?report=' + OTHER_REPORT_ID)[0], 400)
        self.assertEqual(self.request(body={'report_id': OTHER_REPORT_ID})[0], 400)
        self.assertEqual(self.jobs.get.call_count, 2)
        self.assertEqual(self.jobs.get.call_args.args[0]['id'], self.project['id'])
        self.jobs.ensure.assert_not_called()
        self.assertEqual(self.disk_state(), before)

    def test_missing_project_is_404_and_does_not_reach_job_manager(self):
        missing = '/api/projects/' + 'f' * 16 + '/recommendations'
        self.assertEqual(self.request(missing + '?report=' + REPORT_ID)[0], 404)
        self.assertEqual(self.request(missing, {'report_id': REPORT_ID})[0], 404)
        self.jobs.get.assert_not_called()
        self.jobs.ensure.assert_not_called()

    def test_concurrent_and_completed_posts_reuse_one_persisted_worker(self):
        self.use_real_jobs(hold_plan=True)
        with ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(pool.map(lambda _: self.request(body={'report_id': REPORT_ID}), range(2)))
        self.assertTrue(self.worker_entered.wait(2))
        self.assertEqual([reply[0] for reply in replies], [202, 202])
        self.assertEqual(replies[0][1]['id'], replies[1][1]['id'])
        self.assertEqual(self.model.call_count, 1)
        self.query.assert_not_called()
        self.assertEqual(len(self.store.load(self.project['id'])['product_recommendations']), 1)
        self.release_worker.set()
        record = self.completed_record()
        self.assertEqual(record['status'], 'success', record.get('message'))
        self.assertEqual(record['requests'], 1)
        self.assertEqual(self.model.call_count, 2)
        self.query.assert_called_once_with('products', keyword='easy clean pet fountain')
        before = self.disk_state()
        for _ in range(2):
            self.assertEqual(self.request(body={'report_id': REPORT_ID}), (202, record))
        self.assertEqual(self.disk_state(), before)
        self.assertEqual((self.model.call_count, self.query.call_count), (2, 1))

    def test_real_manager_keeps_foreign_report_isolated(self):
        self.use_real_jobs()
        before = self.disk_state()
        self.assertEqual(self.request(self.path + '?report=' + OTHER_REPORT_ID)[0], 400)
        self.assertEqual(self.request(body={'report_id': OTHER_REPORT_ID})[0], 400)
        self.assertEqual(self.disk_state(), before)
        self.model.assert_not_called()
        self.query.assert_not_called()

    def test_no_match_is_cached_until_explicit_retry(self):
        self.use_real_jobs()
        matching_response = copy.deepcopy(self.query.return_value)
        self.query.return_value = {'data': {'items': []}}
        self.assertEqual(self.request(body={'report_id': REPORT_ID})[0], 202)
        empty = self.completed_record()
        self.assertEqual(empty['status'], 'no_match', empty.get('message'))
        self.assertEqual(self.request(body={'report_id': REPORT_ID}), (202, empty))
        self.assertEqual(self.query.call_count, 1)
        self.query.return_value = matching_response
        status, retried = self.request(body={'report_id': REPORT_ID, 'retry': True})
        self.assertEqual(status, 202)
        self.assertNotEqual(retried['id'], empty['id'], '主动重试应新建任务，而不是返回旧的未匹配结果')
        result = self.completed_record()
        self.assertEqual(result['status'], 'success', result.get('message'))
        self.assertEqual(self.query.call_count, 2)
        self.assertEqual(len(self.store.load(self.project['id'])['product_recommendations']), 2)

    def test_unexpected_model_error_is_safe_and_does_not_repeat_consumption(self):
        self.use_real_jobs()
        runner = self.model.side_effect

        def fail_ranking(system, payload, schema):
            if schema is recommendation.RESULT_SCHEMA:
                raise RuntimeError('private-error-fixture-marker')
            return runner(system, payload, schema)

        self.model.side_effect = fail_ranking
        self.assertEqual(self.request(body={'report_id': REPORT_ID})[0], 202)
        failed = self.completed_record()
        self.assertEqual(failed['status'], 'failed')
        self.assertIsNone(failed['result'])
        self.assertEqual(len(failed['products']), 1)
        self.assertEqual(failed['requests'], 1)
        self.assertNotIn('private-error-fixture-marker', json.dumps(failed))
        self.assertFalse(any(b'private-error-fixture-marker' in content for content in self.disk_state().values()))
        before = self.disk_state()
        self.assertEqual(self.request(body={'report_id': REPORT_ID}), (202, failed))
        self.assertEqual(self.disk_state(), before)
        self.assertEqual((self.model.call_count, self.query.call_count), (2, 1))

    def test_import_and_reopen_success_cache_preserve_snapshots_without_start(self):
        self.use_real_jobs()
        self.assertEqual(self.request(body={'report_id': REPORT_ID})[0], 202)
        record = self.completed_record()
        self.assertEqual(record['status'], 'success', record.get('message'))
        exported = self.store.load(self.project['id'])
        # Current rows can change after a report; its recommendation must retain the saved evidence.
        exported['keywords'][0]['translation'] = '导出前新增的译文'
        exported['products'][0]['price'] = 199
        self.model.reset_mock()
        self.query.reset_mock()
        self.jobs.ensure.reset_mock()
        status, restored = self.request('/api/restore', {'project': exported})
        self.assertEqual(status, 201, restored)
        self.assertNotEqual(restored['id'], exported['id'])
        saved = restored['product_recommendations'][0]
        for key in ('report_snapshot', 'evidence_snapshot', 'products', 'queries', 'result', 'source_fingerprint'):
            self.assertEqual(saved[key], record[key], key)
        self.assertEqual(saved['products'][0]['price'], 29.99)
        self.assertEqual(restored['products'][0]['price'], 199)
        before = self.disk_state()
        prefix = '/api/projects/' + restored['id']
        self.assertEqual(self.request(prefix)[0], 200)
        self.assertEqual(self.request(prefix + '/recommendations?report=' + REPORT_ID), (200, saved))
        self.assertEqual(self.disk_state(), before)
        self.jobs.ensure.assert_not_called()
        self.model.assert_not_called()
        self.query.assert_not_called()
        self.assertEqual(self.request(prefix + '/recommendations', {'report_id': REPORT_ID}), (202, saved))
        self.assertEqual(self.disk_state(), before)
        self.model.assert_not_called()
        self.query.assert_not_called()

    def test_import_running_cache_becomes_interrupted_without_resuming(self):
        self.use_real_jobs(hold_plan=True)
        self.assertEqual(self.request(body={'report_id': REPORT_ID})[0], 202)
        self.assertTrue(self.worker_entered.wait(2))
        exported = self.store.load(self.project['id'])
        self.jobs.ensure.reset_mock()
        status, restored = self.request('/api/restore', {'project': exported})
        self.assertEqual(status, 201, restored)
        record = restored['product_recommendations'][0]
        self.assertEqual((record['status'], record['phase']), ('interrupted', 'interrupted'))
        self.assertEqual(record['source_fingerprint'], exported['product_recommendations'][0]['source_fingerprint'])
        prefix = '/api/projects/' + restored['id'] + '/recommendations'
        self.assertEqual(self.request(prefix + '?report=' + REPORT_ID), (200, record))
        self.jobs.ensure.assert_not_called()
        self.assertEqual(self.request(prefix, {'report_id': REPORT_ID}), (202, record))
        self.assertEqual(self.model.call_count, 1)
        self.query.assert_not_called()
        self.assertEqual(len(self.real_jobs.jobs), 1)


if __name__ == '__main__':
    unittest.main()
