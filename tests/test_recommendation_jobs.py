import copy
import json
import tempfile
import threading
import unittest
from unittest.mock import patch

import ai_jobs
import recommendation_jobs as rec
import server
import sources
from test_ai_jobs import MemoryStore
from test_ai_modules import sample_project, module_result


def make_project(modular=True, directions=True):
    source = sample_project()
    source['reviews'][0].update(review_type='social', post_id='p1', platform='reddit')
    p = server.new_project('推荐验证', source['keyword'])
    for kind in ('keywords', 'posts', 'reviews'):
        p[kind] = [server.normalize(kind, row, 'live') for row in source[kind]]
    p['data_version'] = 1
    if modular:
        memory = MemoryStore(p)
        def runner(system, payload, schema, cancel):
            result = module_result('summary', payload['evidence'])
            if not directions:
                result.pop('product_directions')
                result['product_directions'] = []
            return result, {}
        jobs = ai_jobs.AIJobs(memory, threading.RLock(), lambda: 'b' * 16, server.now, runner)
        with patch('ai_jobs.threading.Thread'):
            public = jobs.start(p, {'kind': 'insights', 'modules': ['summary']})
        jobs.work(jobs.jobs[public['id']])
        return memory.p
    prepared = ai_jobs.prepare(p, {'kind': 'insights'})
    ids = [e['id'] for e in prepared['evidence_snapshot']]
    claim = {'text': '清洗负担值得进一步核查', 'evidence_ids': ids}
    audience = {k: '缺少资料，待验证' for k in ai_jobs.INSIGHT_SCHEMA['properties']['audiences']['items']['properties'] if k != 'evidence_ids'}
    audience['evidence_ids'] = ids
    result = {'title': '旧版需求洞察', 'summary': '用户在意清洗维护。', 'core_opportunity': claim,
        'audiences': [audience], 'topics': [{'title': '清洗过程', 'layer': 'A4', 'angle': '维护体验',
            'why': '依据使用问题', 'words': [], 'evidence_ids': ids}], 'cautions': [claim],
        'self_check': dict(no_anxiety=True, narrowest=True, has_contrast=True, real_demand=False, note='购买待验证')}
    p['ai_reports'] = [ai_jobs.normalize_ai_report(dict(prepared, id='b' * 16, status='success',
        data_version=1, report=result), p)]
    return p


def supplier_payload(count=1, start=1):
    return {'data': {'items': [{'asin': f'B{i:09d}', 'title': 'Easy clean pet water fountain',
        'price': 29.99, 'rating': 4.3, 'ratings': 123, 'units': 100, 'month': '2026-08'}
        for i in range(start, start + count)]}}


def model_result(payload, no_match=False):
    ids = [p['id'] for p in payload['products']]
    return {'title': '可研究的参考商品', 'direction': '便于拆洗的饮水机', 'target': '关注维护负担的养宠者',
        'summary': '以真实商品为参照，验证清洗结构与供应链成本。',
        'recommended_product_id': '' if no_match else ids[0],
        'reasons': [] if no_match else [{'text': '结合清洗需求，优先做实际拆洗测试。',
            'product_ids': [ids[0]], 'evidence_ids': [payload['evidence'][0]['id']]}],
        'alternatives': [], 'checks': ['核对采购物流成本和利润', '查看清洗相关评价并打样测试'],
        'no_match_reason': '本次商品与需求差异过大。' if no_match else ''}


class RecommendationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.store = server.Store(temporary.name)
        self.calls, self.model_calls = [], []
        self.counter = 10

    def uid(self):
        self.counter += 1
        return f'{self.counter:016x}'

    def runner(self, system, payload, schema):
        self.model_calls.append(copy.deepcopy(payload))
        if schema is rec.PLAN_SCHEMA:
            return {'queries': [{'query': 'easy clean pet fountain', 'direction': '易清洗饮水机'}]}, {'usage': {'input_tokens': 10}}
        return model_result(payload), {'usage': {'input_tokens': 20, 'secret': 'discard'}}

    def query(self, kind, keyword=''):
        self.calls.append((kind, keyword))
        return supplier_payload()

    def service(self, p=None, runner=None, query=None):
        p = p or make_project()
        self.store.save(p)
        jobs = rec.RecommendationJobs(self.store, threading.RLock(), self.uid, server.now, server.import_rows,
                                     runner or self.runner, query or self.query)
        with patch('recommendation_jobs.threading.Thread'):
            started = jobs.ensure(p, p['ai_reports'][0]['id'])
        return jobs, p, started

    def finish(self, jobs, p, started):
        jobs.work(jobs.jobs[started['id']])
        fresh = self.store.load(p['id'])
        record = jobs.get(fresh, p['ai_reports'][0]['id'])
        rec.normalize_records(fresh['product_recommendations'], fresh)
        return record, fresh

    def test_existing_direction_skips_planning_and_success_cache_survives_imported_product_version(self):
        jobs, p, started = self.service()
        self.assertTrue(jobs.is_running())
        record, fresh = self.finish(jobs, p, started)
        self.assertEqual(record['status'], 'success')
        self.assertEqual(len(self.calls), 1); self.assertEqual(len(self.model_calls), 1)
        self.assertEqual(record['requests'], 1); self.assertEqual(record['usage'], {'input_tokens': 20})
        self.assertGreater(fresh['data_version'], p['data_version'])
        jobs.ai_busy = lambda: True
        for retry in (False, True):
            self.assertEqual(jobs.ensure(fresh, 'b' * 16, retry=retry), record)
        self.assertEqual(len(self.calls), 1); self.assertFalse(jobs.is_running())
        self.assertEqual(record['products'][0]['price'], 29.99)
        self.assertIn('父体月销量', record['products'][0]['sales_kind'])

    def test_legacy_report_plans_once_then_queries_and_ranks(self):
        jobs, p, started = self.service(make_project(modular=False))
        record, _ = self.finish(jobs, p, started)
        self.assertEqual(record['status'], 'success')
        self.assertEqual(len(self.model_calls), 2)
        self.assertNotIn('products', self.model_calls[0])
        self.assertEqual(record['queries'][0]['query'], 'easy clean pet fountain')
        self.assertEqual(record['report_snapshot']['schema_version'], 1)

    def test_two_queries_each_capped_at_ten_and_saved_before_ranking(self):
        p = make_project()
        p['ai_reports'][0]['report']['modules']['summary']['report']['product_directions'][0]['search_terms'] = ['pet fountain', 'cat water fountain', 'ignored third query']
        phases = []
        def query(kind, keyword=''):
            current = self.store.load(p['id'])['product_recommendations'][-1]
            phases.append(current['phase'])
            self.assertEqual(current['requests'], len(phases))
            return supplier_payload(12, start=1 if len(phases) == 1 else 6)
        def runner(system, payload, schema):
            saved = self.store.load(p['id'])
            self.assertEqual(saved['product_recommendations'][-1]['phase'], 'ranking')
            self.assertEqual(len(saved['products']), 15)
            return self.runner(system, payload, schema)
        jobs, p, started = self.service(p, runner, query)
        record, _ = self.finish(jobs, p, started)
        self.assertEqual(record['status'], 'success'); self.assertEqual(phases, ['querying', 'querying'])
        self.assertEqual([q['returned'] for q in record['queries']], [10, 10]); self.assertEqual(len(record['products']), 15)

    def test_failed_query_preserves_other_query_and_hides_provider_details(self):
        p = make_project()
        p['ai_reports'][0]['report']['modules']['summary']['report']['product_directions'][0]['search_terms'] = ['pet fountain', 'cat fountain']
        def query(kind, keyword=''):
            if keyword == 'pet fountain':
                raise sources.SourceError('private-token-and-signed-url', 401)
            return supplier_payload()
        jobs, p, started = self.service(p, query=query)
        record, _ = self.finish(jobs, p, started)
        self.assertEqual(record['status'], 'success'); self.assertEqual(record['queries'][0]['http'], 401)
        self.assertIn('认证失败', record['queries'][0]['error'])
        self.assertNotIn('private-token', json.dumps(record))

    def test_no_products_skips_ranking_and_no_match_is_cached(self):
        jobs, p, started = self.service(query=lambda *a, **k: {'data': {'items': []}})
        record, fresh = self.finish(jobs, p, started)
        self.assertEqual(record['status'], 'no_match'); self.assertFalse(self.model_calls)
        self.assertEqual(record['result']['recommended_product_id'], '')
        self.assertEqual(jobs.ensure(fresh, 'b' * 16), record)

    def test_invalid_asins_never_import_and_model_can_decline_real_candidates(self):
        invalid = supplier_payload(); invalid['data']['items'][0]['asin'] = 'invented'
        jobs, p, started = self.service(query=lambda *a, **k: invalid)
        record, fresh = self.finish(jobs, p, started)
        self.assertEqual(record['status'], 'no_match'); self.assertEqual(fresh['products'], [])
        self.assertEqual(record['queries'][0]['skipped'], 1)
        other = make_project()
        jobs, other, started = self.service(other, runner=lambda system,payload,schema: (model_result(payload,True),{}))
        record, _ = self.finish(jobs, other, started)
        self.assertEqual(record['status'], 'no_match'); self.assertEqual(len(record['products']), 1)

    def test_fake_rank_references_fail_and_retry_is_explicit(self):
        def bad_rank(system, payload, schema):
            result = model_result(payload); result['recommended_product_id'] = 'B999999999'
            return result, {}
        jobs, p, started = self.service(runner=bad_rank)
        record, fresh = self.finish(jobs, p, started)
        self.assertEqual(record['status'], 'failed')
        self.assertEqual(jobs.ensure(fresh, 'b' * 16)['id'], record['id'])
        self.assertEqual(len(self.calls), 1)
        jobs.runner = self.runner
        with patch('recommendation_jobs.threading.Thread'):
            retry = jobs.ensure(fresh, 'b' * 16, retry=True)
        self.assertNotEqual(retry['id'], record['id'])
        retried, _ = self.finish(jobs, p, retry)
        self.assertEqual(retried['status'], 'success'); self.assertEqual(len(self.calls), 2)

    def test_restart_cache_is_interrupted_and_cannot_autostart(self):
        jobs, p, started = self.service()
        restarted = rec.RecommendationJobs(self.store, threading.RLock(), self.uid, server.now, server.import_rows,
                                          lambda *a,**k:self.fail('no automatic AI'), lambda *a,**k:self.fail('no automatic MCP'))
        fresh = self.store.load(p['id'])
        self.assertEqual(restarted.get(fresh, 'b' * 16)['status'], 'interrupted')
        with patch('recommendation_jobs.threading.Thread') as thread:
            self.assertEqual(restarted.ensure(fresh, 'b' * 16)['status'], 'interrupted')
            thread.assert_not_called()
        restored = rec.normalize_records(fresh['product_recommendations'], fresh)
        self.assertEqual(restored[0]['status'], 'interrupted')

    def test_busy_demo_and_incomplete_insight_never_start(self):
        p = make_project(); self.store.save(p)
        jobs = rec.RecommendationJobs(self.store, threading.RLock(), self.uid, server.now, server.import_rows)
        jobs.ai_busy = lambda: True
        with patch('recommendation_jobs.threading.Thread') as thread:
            with self.assertRaises(ValueError): jobs.ensure(p, 'b' * 16)
            jobs.ai_busy = lambda: False
            for change in ('demo', 'running'):
                current = self.store.load(p['id'])
                if change == 'demo': current['demo'] = True
                else: current['demo'] = False; current['ai_reports'][0]['status'] = 'running'
                self.store.save(current, current['revision'])
                with self.assertRaises(ValueError): jobs.ensure(current, 'b' * 16)
            thread.assert_not_called()

    def test_restore_checks_report_product_query_and_result_boundaries(self):
        jobs, p, started = self.service()
        record, fresh = self.finish(jobs, p, started)
        renamed = copy.deepcopy(fresh); renamed['id'] = 'f' * 16
        self.assertEqual(rec.normalize_records([record], renamed)[0], record)
        legacy = copy.deepcopy(record); legacy['products'][0].pop('watched')
        self.assertFalse(rec.normalize_records([legacy], fresh)[0]['products'][0]['watched'])
        for mutate in (
            lambda r:r.update(source_fingerprint='0'*64),
            lambda r:r['evidence_snapshot'][0].update(text='modified original'),
            lambda r:r['products'][0].update(id='B999999999'),
            lambda r:r['products'][0].update(price=-1),
            lambda r:r['products'][0].update(image='javascript:alert(1)'),
            lambda r:r['queries'][0].update(returned=10),
            lambda r:r.update(requests=2),
            lambda r:r['result']['reasons'][0].update(evidence_ids=['keywords:invented']),
            lambda r:r['result'].update(price=1000)):
            bad = copy.deepcopy(record); mutate(bad)
            with self.assertRaises(ValueError): rec.normalize_records([bad], fresh)

    def test_latest_revision_and_other_project_are_preserved_during_calls(self):
        p = make_project(); other = make_project(); self.store.save(other)
        def query(kind, keyword=''):
            latest = self.store.load(p['id']); latest['name'] = '期间改名'; self.store.save(latest, latest['revision'])
            return supplier_payload()
        jobs, p, started = self.service(p, query=query)
        record, fresh = self.finish(jobs, p, started)
        self.assertEqual(record['status'], 'success'); self.assertEqual(fresh['name'], '期间改名')
        self.assertEqual(self.store.load(other['id'])['products'], [])
        self.assertEqual(self.store.load(other['id']).get('product_recommendations', []), [])


if __name__ == '__main__':
    unittest.main()
