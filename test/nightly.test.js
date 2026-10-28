// 試験版機能(レポート送信・遮断)の純粋関数テスト。`npm run compile` 後に `npm test` で実行する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadExtension } = require('./helpers');

const { T, state } = loadExtension();

const NOW = Date.parse('2026-10-28T09:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const IDLE = { state: 'idle', saved: null, changes: [] };
const ACTIVE = { state: 'active', saved: false, changes: [iso(NOW - 3_600_000 - 1)] };
const DEFAULTS = { allowedPlans: ['business', 'enterprise'], requireOrganization: '', warnOnOrganizationless: true };
const BUS = { login: 'dev', apiEndpoint: 'https://api.business.githubcopilot.com', tier: 'business' };
const IND = { login: 'dev', apiEndpoint: 'https://api.individual.githubcopilot.com', tier: 'individual' };

function plan(overrides) {
    return T.planEnforcement({
        mode: 'disableAI', guardEnabled: true, status: 'violation', codes: ['individual_tier'],
        onUnknown: false, journal: IDLE, globalValue: undefined, now: NOW, ...overrides
    });
}

// --- 違反コード(evaluate が codes を出すこと) ---
test('codes: 個人エンドポイントは individual_tier(明確な証拠)', () => {
    state.settings = { ...DEFAULTS };
    const r = T.evaluate(IND, undefined, undefined, 'dev');
    assert.deepEqual(r.codes, ['individual_tier']);
    assert.equal(T.hasStrongViolation(r.codes), true);
});
test('codes: 未知エンドポイントは endpoint_unknown(遮断の根拠にしない)', () => {
    state.settings = { ...DEFAULTS };
    const r = T.evaluate({ login: 'dev', apiEndpoint: 'https://api.newtier.githubcopilot.com', tier: 'unknown' }, undefined, undefined, 'dev');
    assert.deepEqual(r.codes, ['endpoint_unknown']);
    assert.equal(T.hasStrongViolation(r.codes), false);
});
test('codes: allowedPlans の設定ミス(空)による違反は遮断の根拠にしない', () => {
    state.settings = { ...DEFAULTS, allowedPlans: [] };
    const r = T.evaluate(BUS, undefined, undefined, 'dev');
    assert.equal(r.status, 'violation');
    assert.deepEqual(r.codes, ['tier_not_allowed']);
    assert.equal(T.hasStrongViolation(r.codes), false);
});
test('codes: 既知の個人プラン名は individual_plan、未知のプラン名は plan_not_allowed', () => {
    state.settings = { ...DEFAULTS };
    const a = T.evaluate(BUS, { login: 'dev', copilot_plan: 'individual_pro', organization_login_list: ['o'] }, undefined, 'dev');
    assert.ok(a.codes.includes('individual_plan'));
    const b = T.evaluate(BUS, { login: 'dev', copilot_plan: 'brand_new_plan', organization_login_list: ['o'] }, undefined, 'dev');
    assert.deepEqual(b.codes, ['plan_not_allowed']);
    assert.equal(T.hasStrongViolation(b.codes), false);
});
test('codes: Free シグナルは free_sku / free_quota / no_seat', () => {
    state.settings = { ...DEFAULTS };
    const r = T.evaluate(IND, { login: 'dev', copilot_plan: 'free', access_type_sku: 'free_limited_copilot', organization_login_list: [], can_signup_for_limited: true, limited_user_quotas: {} }, undefined, 'dev');
    for (const c of ['individual_tier', 'individual_plan', 'free_sku', 'free_quota', 'no_seat', 'no_seat_org']) {
        assert.ok(r.codes.includes(c), `missing ${c}`);
    }
});
test('codes: 必須 Organization — 別組織のシートは required_org_seat_mismatch、404 は org_not_member、pending は弱い', () => {
    state.settings = { ...DEFAULTS, requireOrganization: 'my-org' };
    const a = T.evaluate(BUS, { login: 'dev', copilot_plan: 'business', organization_login_list: ['other-org'] }, undefined, 'dev');
    assert.deepEqual(a.codes, ['required_org_seat_mismatch']);
    assert.equal(a.requiredOrgMatch, false);
    const b = T.evaluate(BUS, undefined, { org: 'my-org', state: 'none', detail: 'none' }, 'dev');
    assert.deepEqual(b.codes, ['org_not_member']);
    const c = T.evaluate(BUS, undefined, { org: 'my-org', state: 'pending', detail: 'pending' }, 'dev');
    assert.deepEqual(c.codes, ['org_pending']);
    assert.equal(T.hasStrongViolation(c.codes), false);
    const d = T.evaluate(BUS, { login: 'dev', copilot_plan: 'business', organization_login_list: ['my-org'] }, undefined, 'dev');
    assert.equal(d.requiredOrgMatch, true);
    assert.deepEqual(d.codes, []);
});
test('codes: requireOrganization 未設定なら requiredOrgMatch は null', () => {
    state.settings = { ...DEFAULTS };
    assert.equal(T.evaluate(BUS, undefined, undefined, 'dev').requiredOrgMatch, null);
});

// --- planEnforcement: 状態遷移 ---
test('enforce: 明確な違反 × idle → apply(元値は呼び出し側が保存)', () => {
    const p = plan({});
    assert.equal(p.action, 'apply');
    assert.equal(p.wantBlock, true);
});
test('enforce: 弱い違反(未知 SKU/設定ミス)では遮断しない', () => {
    assert.equal(plan({ codes: ['endpoint_unknown'] }).action, 'none');
    assert.equal(plan({ codes: ['plan_not_allowed', 'org_pending', 'no_seat_org'] }).action, 'none');
});
test('enforce: mode=warn では適用せず、適用中なら復元', () => {
    assert.equal(plan({ mode: 'warn' }).action, 'none');
    assert.equal(plan({ mode: 'warn', journal: ACTIVE, globalValue: true }).action, 'restore');
});
test('enforce: 拡張が無効化されたら適用中のものを復元', () => {
    assert.equal(plan({ guardEnabled: false, journal: ACTIVE, globalValue: true }).action, 'restore');
});
test('enforce: ok になったら復元、ok × idle は何もしない', () => {
    assert.equal(plan({ status: 'ok', codes: [], journal: ACTIVE, globalValue: true }).action, 'restore');
    assert.equal(plan({ status: 'ok', codes: [] }).action, 'none');
});
test('enforce: unknown は既定で現状維持(fail-safe)。適用中は維持、未適用は何もしない', () => {
    const keep = plan({ status: 'unknown', codes: [], journal: ACTIVE, globalValue: true });
    assert.equal(keep.action, 'none');
    assert.equal(keep.wantBlock, true);
    const idle = plan({ status: 'unknown', codes: [] });
    assert.equal(idle.action, 'none');
    assert.equal(idle.wantBlock, false);
});
test('enforce: enforcementOnUnknown は 15 分の猶予後に適用(unknownSince を記録)', () => {
    const first = plan({ status: 'unknown', codes: [], onUnknown: true });
    assert.equal(first.action, 'none');
    assert.ok(first.journal.unknownSince, 'unknownSince が記録される');
    const later = plan({ status: 'unknown', codes: [], onUnknown: true, journal: { ...IDLE, unknownSince: iso(NOW - 16 * 60_000) } });
    assert.equal(later.action, 'apply');
    const okAgain = plan({ status: 'ok', codes: [], journal: { ...IDLE, unknownSince: iso(NOW - 16 * 60_000) } });
    assert.equal(okAgain.journal.unknownSince, undefined, 'ok で unknownSince はクリア');
});
test('enforce: 適用中に利用者が手で戻していたら reapply、実効値が true なら none', () => {
    assert.equal(plan({ journal: ACTIVE, globalValue: false }).action, 'reapply');
    assert.equal(plan({ journal: ACTIVE, globalValue: undefined }).action, 'reapply');
    assert.equal(plan({ journal: ACTIVE, globalValue: true }).action, 'none');
});
test('enforce: applying/releasing(中断)も「適用中」として扱い、saved を上書きしない前提で遷移する', () => {
    assert.equal(plan({ journal: { ...ACTIVE, state: 'applying' }, globalValue: true }).action, 'none');
    assert.equal(plan({ journal: { ...ACTIVE, state: 'applying' }, globalValue: undefined }).action, 'reapply');
    assert.equal(plan({ status: 'ok', codes: [], journal: { ...ACTIVE, state: 'releasing' }, globalValue: true }).action, 'restore');
});
test('enforce: 手動停止中は適用せず、適用中なら復元。期限切れは記録から消える', () => {
    const sus = { ...IDLE, suspendedUntil: iso(NOW + 30 * 60_000) };
    assert.equal(plan({ journal: sus }).action, 'none');
    assert.equal(plan({ journal: { ...ACTIVE, suspendedUntil: iso(NOW + 30 * 60_000) }, globalValue: true }).action, 'restore');
    const expired = plan({ journal: { ...IDLE, suspendedUntil: iso(NOW - 1) } });
    assert.equal(expired.action, 'apply');
    assert.equal(expired.journal.suspendedUntil, undefined);
});
test('enforce: flapping 防止 — 直近 5 分以内の変更後は apply を見送る(restore は見送らない)', () => {
    const recent = { ...IDLE, changes: [iso(NOW - 60_000)] };
    const p = plan({ journal: recent });
    assert.equal(p.action, 'none');
    assert.match(p.reason, /cooldown/);
    const r = plan({ status: 'ok', codes: [], journal: { ...ACTIVE, changes: [iso(NOW - 60_000)] }, globalValue: true });
    assert.equal(r.action, 'restore');
});
test('enforce: flapping 防止 — 1 時間に 4 回変更したら restore も含めて見送り、古い変更は掃除される', () => {
    const busy = { ...ACTIVE, changes: [1, 2, 3, 4].map(n => iso(NOW - n * 10 * 60_000)) };
    const p = plan({ status: 'ok', codes: [], journal: busy, globalValue: true });
    assert.equal(p.action, 'none');
    assert.match(p.reason, /flapping/);
    const stale = { ...ACTIVE, changes: [1, 2, 3, 4].map(n => iso(NOW - (60 + n) * 60_000)) };
    assert.equal(plan({ status: 'ok', codes: [], journal: stale, globalValue: true }).action, 'restore');
    assert.equal(plan({ journal: stale, globalValue: true }).journal.changes.length, 0);
});

// --- validateReportUrl ---
test('report url: https のみ許可、localhost は http 可、認証情報入りは拒否', () => {
    assert.equal(T.validateReportUrl('https://hooks.example.com/x').ok, true);
    assert.equal(T.validateReportUrl('https://hooks.example.com/x').host, 'hooks.example.com');
    assert.equal(T.validateReportUrl('http://localhost:8080/x').ok, true);
    assert.equal(T.validateReportUrl('http://127.0.0.1:8080/x').ok, true);
    assert.equal(T.validateReportUrl('http://hooks.example.com/x').ok, false);
    assert.equal(T.validateReportUrl('https://user:pw@hooks.example.com/x').ok, false);
    assert.equal(T.validateReportUrl('ftp://hooks.example.com/x').ok, false);
    assert.equal(T.validateReportUrl('not a url').ok, false);
    assert.equal(T.validateReportUrl('').ok, false);
});

// --- buildReportPayload ---
function payload(overrides) {
    const ev = {
        status: 'violation', plan: 'free', tier: 'individual', sku: 'free_limited_copilot', account: 'octocat',
        orgs: ['secret-org'], orgsAuthoritative: true, apiEndpoint: 'https://api.individual.githubcopilot.com',
        source: 'public+internal', violations: ['個人向け Copilot で動作しています'], codes: ['individual_tier', 'free_sku'],
        infos: ['内部メモ'], requiredOrgMatch: false, accessToken: 'ghu_SHOULD_NEVER_APPEAR'
    };
    return T.buildReportPayload({
        event: 'violation', ev,
        settings: { url: 'https://h/x', headers: {}, format: 'json', events: [], heartbeatHours: 24, deviceFields: ['hostname', 'installId'] },
        state: { installId: 'iid-1', seq: 7 },
        device: { hostname: 'PC-1', osUser: 'Taro Yamada' },
        extensionVersion: '1.4.0', vscodeVersion: '1.143.1', remoteName: undefined,
        enforcementMode: 'disableAI', enforcementActive: true, requireOrganization: 'my-org', dedupeKey: 'dk-1', now: NOW, ...overrides
    });
}
test('payload: ホワイトリスト方式 — トークン・補足・組織名は含まれない', () => {
    const s = JSON.stringify(payload({}));
    assert.ok(!s.includes('ghu_SHOULD_NEVER_APPEAR'));
    assert.ok(!s.includes('secret-org'));
    assert.ok(!s.includes('内部メモ'));
});
test('payload: 必須項目と必須 Organization の一致だけを送る', () => {
    const p = payload({});
    assert.equal(p.schema, 1);
    assert.equal(p.event, 'violation');
    assert.match(p.eventId, /^[0-9a-f-]{36}$/, 'eventId は送信ごとに一意な UUID');
    assert.equal(p.dedupeKey, 'dk-1');
    assert.equal(p.seq, 7);
    assert.equal(p.account, 'octocat');
    assert.deepEqual(p.violationCodes, ['individual_tier', 'free_sku']);
    assert.equal(p.requiredOrganization, 'my-org');
    assert.equal(p.requiredOrgMatch, false);
    assert.equal(p.seatOrgsKnown, true);
    assert.equal(p.enforcementMode, 'disableAI');
    assert.deepEqual(p.extension, { id: 'Kuro524.copilot-license-guard', version: '1.4.0' });
    assert.deepEqual(p.vscode, { version: '1.143.1', remoteName: null });
    assert.equal(p.timestamp, '2026-10-28T09:00:00.000Z');
});
test('payload: deviceFields に従って端末情報を絞る(既定は hostname + installId、osUser は opt-in)', () => {
    assert.deepEqual(payload({}).device, { hostname: 'PC-1', installId: 'iid-1' });
    const none = payload({ settings: { url: 'https://h/x', headers: {}, format: 'json', events: [], heartbeatHours: 24, deviceFields: [] } });
    assert.deepEqual(none.device, {});
    const all = payload({ settings: { url: 'https://h/x', headers: {}, format: 'json', events: [], heartbeatHours: 24, deviceFields: ['hostname', 'osUser', 'installId'] } });
    assert.equal(all.device.osUser, 'Taro Yamada');
});
test('payload: ev が無い(test/monitoringDisabled)場合も壊れない', () => {
    const p = payload({ ev: undefined, event: 'test', extra: { note: 'manual test' } });
    assert.equal(p.status, 'unknown');
    assert.equal(p.account, '');
    assert.deepEqual(p.violationCodes, []);
    assert.equal(p.note, 'manual test');
});

// --- formatSlackText ---
test('slack: 利用者由来の文字列をエスケープし <!channel> 等を注入できない。文言はコード由来の定型文', () => {
    const p = payload({ ev: { status: 'violation', plan: 'free', tier: 'individual', sku: '', account: '<!channel> & <@U1>', orgs: [], orgsAuthoritative: false, apiEndpoint: '', source: 'public', violations: ['x <b> secret-org'], codes: ['individual_tier'], infos: [], requiredOrgMatch: null } });
    const text = T.formatSlackText(p);
    assert.ok(!text.includes('<!channel>'));
    assert.ok(text.includes('&lt;!channel&gt; &amp; &lt;@U1&gt;'));
    assert.ok(!text.includes('secret-org'), '元の文言(実データ入り)は使わない');
    assert.ok(text.includes('• 個人向け Copilot エンドポイントで動作しています'));
    assert.ok(text.startsWith('⚠️ Copilot License Guard — violation:'));
});

// --- payload: 文言経由の実データ漏れ(レビュー指摘) ---
test('payload: 違反文言に組織名が含まれていても送信ペイロードには出ない(コード由来の定型文に置換)', () => {
    state.settings = { ...DEFAULTS, requireOrganization: 'my-org' };
    const ev = T.evaluate(BUS, { login: 'dev', copilot_plan: 'business', organization_login_list: ['side-gig-org', 'other-employer'] }, undefined, 'dev');
    assert.ok(ev.violations[0].includes('side-gig-org'), 'ローカル表示用の文言には組織名が入る(前提)');
    const p = payload({ ev });
    const s = JSON.stringify(p);
    assert.ok(!s.includes('side-gig-org') && !s.includes('other-employer'));
    assert.deepEqual(p.violationCodes, ['required_org_seat_mismatch']);
    assert.deepEqual(p.violations, ['必須 Organization 以外からシートが提供されています']);
});

// --- codes: SKU の部分一致(ヒューリスティック)は遮断の根拠にしない(レビュー指摘) ---
test('codes: copilot_plan が無く SKU が未知(部分一致で individual/free に丸まる)なら plan_not_allowed(弱い)', () => {
    state.settings = { ...DEFAULTS };
    const r = T.evaluate(BUS, { login: 'dev', access_type_sku: 'copilot_enterprise_seat_limited_trial', organization_login_list: ['o'] }, undefined, 'dev');
    assert.equal(r.status, 'violation');
    assert.deepEqual(r.codes, ['plan_not_allowed']);
    assert.equal(T.hasStrongViolation(r.codes), false);
    const exact = T.evaluate(IND, { login: 'dev', access_type_sku: 'free_limited_copilot', organization_login_list: [] }, undefined, 'dev');
    assert.ok(exact.codes.includes('individual_plan'), '既知 SKU の完全一致は明確な証拠');
});

// --- decideReportEvents ---
const EVENTS = ['violation', 'recovered', 'unknown', 'heartbeat', 'enforcement', 'monitoringDisabled'];
const HB_FUTURE = iso(NOW + 3_600_000);
function decide(overrides) {
    return T.decideReportEvents({ status: 'violation', key: 'violation:individual_tier', state: { installId: 'i', seq: 0, nextHeartbeatAt: HB_FUTURE }, events: EVENTS, now: NOW, ...overrides });
}
test('decide: 初回の違反は送る。同じ内容は 24 時間以内なら送らず、24 時間経てば再送', () => {
    assert.deepEqual(decide({}).events, ['violation']);
    const sent = { installId: 'i', seq: 1, lastSentStatus: 'violation', lastSentKey: 'violation:individual_tier', lastSentAt: iso(NOW - 3_600_000), openViolationKey: 'violation:individual_tier', lastViolationSentAt: iso(NOW - 3_600_000), nextHeartbeatAt: HB_FUTURE };
    assert.deepEqual(decide({ state: sent }).events, []);
    assert.deepEqual(decide({ state: { ...sent, lastViolationSentAt: iso(NOW - 25 * 3_600_000) } }).events, ['violation']);
});
test('decide: 違反の再送タイマーはハートビートの送信に影響されない(lastSentAt ではなく lastViolationSentAt)', () => {
    const sent = { installId: 'i', seq: 9, lastSentStatus: 'violation', lastSentKey: 'violation:individual_tier', lastSentAt: iso(NOW - 60_000), openViolationKey: 'violation:individual_tier', lastViolationSentAt: iso(NOW - 25 * 3_600_000), nextHeartbeatAt: HB_FUTURE };
    assert.deepEqual(decide({ state: sent }).events, ['violation']);
});
test('decide: 違反内容が変われば即送る', () => {
    const sent = { installId: 'i', seq: 1, lastSentStatus: 'violation', lastSentKey: 'violation:individual_tier', lastSentAt: iso(NOW - 60_000), openViolationKey: 'violation:individual_tier', lastViolationSentAt: iso(NOW - 60_000), nextHeartbeatAt: HB_FUTURE };
    assert.deepEqual(decide({ state: sent, key: 'violation:free_sku,individual_tier' }).events, ['violation']);
});
test('decide: violation → ok は recovered、ok → ok は何も送らない', () => {
    const sent = { installId: 'i', seq: 1, lastSentStatus: 'violation', lastSentKey: 'k', lastSentAt: iso(NOW - 60_000), openViolationKey: 'k', lastViolationSentAt: iso(NOW - 60_000), nextHeartbeatAt: HB_FUTURE };
    assert.deepEqual(decide({ status: 'ok', key: 'ok:', state: sent }).events, ['recovered']);
    assert.deepEqual(decide({ status: 'ok', key: 'ok:', state: { ...sent, lastSentStatus: 'ok', openViolationKey: undefined } }).events, []);
});
test('decide: violation → unknown → ok でも recovered を送る(未解消の違反を保持)', () => {
    const afterUnknown = { installId: 'i', seq: 2, lastSentStatus: 'unknown', lastSentKey: 'unknown:', lastSentAt: iso(NOW - 60_000), openViolationKey: 'violation:individual_tier', lastViolationSentAt: iso(NOW - 120_000), nextHeartbeatAt: HB_FUTURE };
    assert.deepEqual(decide({ status: 'ok', key: 'ok:', state: afterUnknown }).events, ['recovered']);
    const afterDisabled = { ...afterUnknown, lastSentStatus: 'disabled', lastSentKey: 'disabled' };
    assert.deepEqual(decide({ status: 'ok', key: 'ok:', state: afterDisabled }).events, ['recovered']);
});
test('decide: unknown / monitoringDisabled は遷移時のみ', () => {
    const base = { installId: 'i', seq: 1, lastSentStatus: 'ok', lastSentKey: 'ok:', lastSentAt: iso(NOW - 60_000), nextHeartbeatAt: HB_FUTURE };
    assert.deepEqual(decide({ status: 'unknown', key: 'unknown:', state: base }).events, ['unknown']);
    assert.deepEqual(decide({ status: 'unknown', key: 'unknown:', state: { ...base, lastSentStatus: 'unknown' } }).events, []);
    assert.deepEqual(decide({ status: 'disabled', key: 'disabled', state: base }).events, ['monitoringDisabled']);
    assert.deepEqual(decide({ status: 'disabled', key: 'disabled', state: { ...base, lastSentStatus: 'disabled' } }).events, []);
});
test('decide: heartbeat は期限到来で送る。初回は初期化フラグのみ。次回時刻は呼び出し側が送信成功後に進める', () => {
    const first = decide({ status: 'ok', key: 'ok:', state: { installId: 'i', seq: 0, lastSentStatus: 'ok' } });
    assert.deepEqual(first.events, []);
    assert.equal(first.initHeartbeat, true);
    const due = decide({ status: 'ok', key: 'ok:', state: { installId: 'i', seq: 1, lastSentStatus: 'ok', nextHeartbeatAt: iso(NOW - 1) } });
    assert.deepEqual(due.events, ['heartbeat']);
    assert.equal(due.initHeartbeat, false);
    // 送信に失敗しても state は変わらないので、次のチェックでも due のまま(間隔を丸ごと飛ばさない)
    assert.deepEqual(decide({ status: 'ok', key: 'ok:', state: { installId: 'i', seq: 1, lastSentStatus: 'ok', nextHeartbeatAt: iso(NOW - 1) }, now: NOW + 1_800_000 }).events, ['heartbeat']);
    const notDue = decide({ status: 'ok', key: 'ok:', state: { installId: 'i', seq: 1, lastSentStatus: 'ok', nextHeartbeatAt: iso(NOW + 1) } });
    assert.deepEqual(notDue.events, []);
});
test('decide: 他のイベントがある回はハートビートを重ねない', () => {
    const r = decide({ state: { installId: 'i', seq: 0, nextHeartbeatAt: iso(NOW - 1) } });
    assert.deepEqual(r.events, ['violation']);
});
test('decide: events で無効化したイベントは送らない', () => {
    assert.deepEqual(decide({ events: ['heartbeat'] }).events, []);
    assert.deepEqual(decide({ status: 'ok', key: 'ok:', state: { installId: 'i', seq: 1, lastSentStatus: 'violation', lastSentKey: 'k', lastSentAt: iso(NOW), openViolationKey: 'k', nextHeartbeatAt: HB_FUTURE }, events: ['violation'] }).events, []);
});
// --- reportDedupeKey: 複数ウィンドウが同じ出来事を送っても同じ鍵になり、別の出来事(同日の再違反)は別の鍵になる ---
test('dedupeKey: 同じ状態スナップショットからは同じ鍵、連番や数十秒の差では変わらない。installId は平文で含まれない', () => {
    const st = { installId: 'SECRET-INSTALL-ID', seq: 0, lastSentStatus: 'ok', lastSentAt: '2026-10-28T08:00:00.000Z', nextHeartbeatAt: '2026-10-29T09:00:00.000Z' };
    const a = T.reportDedupeKey('violation', 'violation:individual_tier', st, NOW);
    const b = T.reportDedupeKey('violation', 'violation:individual_tier', { ...st, seq: 99 }, NOW + 60_000);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{32}$/, 'SHA-256 の先頭 32 桁');
    assert.ok(!a.includes('SECRET'), 'installId を含まない');
    assert.notEqual(a, T.reportDedupeKey('violation', 'violation:free_sku', st, NOW), '内容が違えば別');
});
test('dedupeKey: 違反 → 復帰 → 同日に再違反 は別の鍵(直前の送信状態が変わるため)、24 時間後の再送も別の鍵', () => {
    const first = { installId: 'i', seq: 1, lastSentStatus: 'ok', lastSentAt: '2026-10-28T08:00:00.000Z' };
    const k1 = T.reportDedupeKey('violation', 'violation:individual_tier', first, NOW);
    const afterRecovered = { installId: 'i', seq: 3, lastSentStatus: 'ok', lastSentKey: 'ok:', lastSentAt: '2026-10-28T09:30:00.000Z' };
    const k2 = T.reportDedupeKey('violation', 'violation:individual_tier', afterRecovered, NOW + 2 * 3_600_000);
    assert.notEqual(k1, k2);
    const afterFirstSend = { installId: 'i', seq: 2, lastSentStatus: 'violation', lastSentKey: 'violation:individual_tier', lastSentAt: '2026-10-28T09:00:01.000Z' };
    const k3 = T.reportDedupeKey('violation', 'violation:individual_tier', afterFirstSend, NOW + 25 * 3_600_000);
    assert.notEqual(k1, k3);
});
test('dedupeKey: recovered は未解消違反の送信時刻で、heartbeat は予定時刻で決まる', () => {
    const st = { installId: 'i', seq: 0, openViolationKey: 'violation:individual_tier', lastViolationSentAt: '2026-10-28T09:00:00.000Z', nextHeartbeatAt: '2026-10-29T09:00:00.000Z' };
    assert.equal(T.reportDedupeKey('recovered', 'ok:', st, NOW), T.reportDedupeKey('recovered', 'ok:', { ...st, seq: 5 }, NOW + 1000));
    assert.notEqual(T.reportDedupeKey('recovered', 'ok:', st, NOW), T.reportDedupeKey('recovered', 'ok:', { ...st, lastViolationSentAt: '2026-10-28T11:00:00.000Z' }, NOW));
    assert.equal(T.reportDedupeKey('heartbeat', 'ok:', st, NOW), T.reportDedupeKey('heartbeat', 'ok:', { ...st, seq: 9 }, NOW + 60_000));
});

// --- planEnforcement: releasing は unknown でも復元側に倒す(レビュー指摘) ---
test('enforce: 復元の途中(releasing)で中断した後に unknown になっても、再適用せず復元を完了させる', () => {
    const releasing = { state: 'releasing', saved: null, changes: [iso(NOW - 10 * 60_000)] };
    const p = plan({ status: 'unknown', codes: [], journal: releasing, globalValue: undefined });
    assert.equal(p.action, 'restore');
    const p2 = plan({ status: 'unknown', codes: [], journal: releasing, globalValue: true });
    assert.equal(p2.action, 'restore');
    const applying = { state: 'applying', saved: null, changes: [iso(NOW - 10 * 60_000)] };
    assert.equal(plan({ status: 'unknown', codes: [], journal: applying, globalValue: true }).action, 'none', 'applying は維持');
});