// 判定ロジック(純粋関数)の回帰テスト。`npm run compile` 後に `npm test` で実行する。
// 旧 verify-logic.js (v1.2.0 レビュー時) の 82 ケースを node:test に移植したもの。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadExtension } = require('./helpers');

const { T, state } = loadExtension();

function eq(label, actual, expected) {
    test(label, () => { assert.deepEqual(actual, expected); });
}
// --- tierFromApiEndpoint (実測値ベース) ---
eq('Business 実測値', T.tierFromApiEndpoint('https://api.business.githubcopilot.com'), 'business');
eq('個人 実測値', T.tierFromApiEndpoint('https://api.individual.githubcopilot.com'), 'individual');
eq('Enterprise 想定', T.tierFromApiEndpoint('https://api.enterprise.githubcopilot.com'), 'business');
eq('旧来ホスト', T.tierFromApiEndpoint('https://api.githubcopilot.com'), 'individual');
eq('空文字', T.tierFromApiEndpoint(''), 'unknown');
eq('無関係ドメイン', T.tierFromApiEndpoint('https://evil.example.com'), 'unknown');
eq('紛らわしいドメイン(サフィックス偽装)', T.tierFromApiEndpoint('https://api.business.githubcopilot.com.evil.test'), 'unknown');
eq('サフィックス偽装2(ラベル境界なし)', T.tierFromApiEndpoint('https://api.business.evil-githubcopilot.com'), 'unknown');
eq('サフィックス偽装3(連結)', T.tierFromApiEndpoint('https://api.business.xgithubcopilot.com'), 'unknown');
eq('userinfo 偽装', T.tierFromApiEndpoint('https://api.business.githubcopilot.com@evil.test'), 'unknown');
eq('大文字混在は正規化される', T.tierFromApiEndpoint('https://API.Business.GitHubCopilot.com'), 'business');
eq('URL として不正な値', T.tierFromApiEndpoint('not a url api.business.githubcopilot.com'), 'unknown');
eq('末尾ドット', T.tierFromApiEndpoint('https://api.business.githubcopilot.com./'), 'unknown');
eq('business を含む別ラベル', T.tierFromApiEndpoint('https://mybusiness.githubcopilot.com'), 'unknown');
eq('未知のサブドメイン', T.tierFromApiEndpoint('https://api.newtier.githubcopilot.com'), 'unknown');

// --- tierOfPlan ---
eq('business', T.tierOfPlan('business'), 'business');
eq('enterprise', T.tierOfPlan('enterprise'), 'business');
eq('free', T.tierOfPlan('free'), 'individual');
eq('individual_max', T.tierOfPlan('individual_max'), 'individual');
eq('unknown', T.tierOfPlan('unknown'), 'unknown');

const BUS = { login: 'dev', apiEndpoint: 'https://api.business.githubcopilot.com', tier: 'business' };
const IND = { login: 'dev', apiEndpoint: 'https://api.individual.githubcopilot.com', tier: 'individual' };
const UNK = { login: 'dev', apiEndpoint: '', tier: 'unknown' };
const DEFAULTS = { allowedPlans: ['business', 'enterprise'], requireOrganization: '', warnOnOrganizationless: true };

// --- evaluate: 公開APIのみ ---
state.settings = { ...DEFAULTS };
let r = T.evaluate(BUS, undefined, undefined, 'dev');
eq('Business は OK', r.status, 'ok');
eq('source=public', r.source, 'public');
eq('warnOnOrganizationless は違反にしない', r.violations.length, 0);
eq('補足が出る', r.infos.length > 0, true);
eq('プラン表示', r.plan, 'business/enterprise');

state.settings = { ...DEFAULTS };
r = T.evaluate(IND, undefined, undefined, 'dev');
eq('個人プランは違反', r.status, 'violation');
eq('違反理由が1件', r.violations.length, 1);

state.settings = { ...DEFAULTS };
r = T.evaluate(UNK, undefined, undefined, 'dev');
eq('判定不能は fail-safe で違反', r.status, 'violation');

state.settings = { ...DEFAULTS, allowedPlans: ['business', 'enterprise', 'free'] };
r = T.evaluate(IND, undefined, undefined, 'dev');
eq('free を許可すれば個人でも OK', r.status, 'ok');

// --- evaluate: requireOrganization (公開APIのみ) ---
const M = (state, detail) => ({ org: 'my-org', state, detail: detail || state });

state.settings = { ...DEFAULTS, requireOrganization: 'my-org' };
r = T.evaluate(BUS, undefined, M('active'), 'dev');
eq('active なら OK', r.status, 'ok');
eq('シート提供元ではない旨の補足', r.infos.some(i => i.includes('シートを提供している')), true);
eq('orgsAuthoritative=false', r.orgsAuthoritative, false);
eq('org 名が表示される', r.orgs, ['my-org']);

state.settings = { ...DEFAULTS, requireOrganization: 'my-org' };
r = T.evaluate(BUS, undefined, M('none'), 'dev');
eq('非メンバー(404)は違反', r.status, 'violation');

state.settings = { ...DEFAULTS, requireOrganization: 'my-org' };
r = T.evaluate(BUS, undefined, M('pending'), 'dev');
eq('参加保留は違反', r.status, 'violation');

state.settings = { ...DEFAULTS, requireOrganization: 'my-org' };
r = T.evaluate(BUS, undefined, M('unverifiable', 'HTTP 403 Forbidden'), 'dev');
eq('確認不能(403/IP許可リスト)は違反にしない', r.status, 'ok');
eq('確認不能の補足が出る', r.infos.some(i => i.includes('確認できませんでした')), true);

state.settings = { ...DEFAULTS, requireOrganization: 'my-org' };
r = T.evaluate(BUS, undefined, undefined, 'dev');
eq('read:org 未付与時は違反にせず補足', r.status, 'ok');
eq('read:org の補足が出る', r.infos.some(i => i.includes('read:org')), true);

// --- evaluate: 公開API + 内部API ---
state.settings = { ...DEFAULTS };
r = T.evaluate(BUS, {
    login: 'dev', copilot_plan: 'business', access_type_sku: 'copilot_for_business_seat',
    organization_login_list: ['my-org']
}, undefined, 'dev');
eq('Business + 内部API は OK', r.status, 'ok');
eq('source=public+internal', r.source, 'public+internal');
eq('プラン名が詳細化', r.plan, 'business');
eq('SKU が入る', r.sku, 'copilot_for_business_seat');
eq('orgsAuthoritative=true', r.orgsAuthoritative, true);

state.settings = { ...DEFAULTS };
r = T.evaluate(IND, {
    login: 'dev', copilot_plan: 'free', access_type_sku: 'free_limited_copilot',
    organization_login_list: [], can_signup_for_limited: true, limited_user_quotas: { chat: 50 }
}, undefined, 'dev');
eq('Free は違反', r.status, 'violation');
eq('違反理由が複数列挙される', r.violations.length >= 5, true);

state.settings = { ...DEFAULTS };
r = T.evaluate(BUS, {
    login: 'dev', copilot_plan: 'business', access_type_sku: 'copilot_for_business_seat',
    organization_login_list: []
}, undefined, 'dev');
eq('シート提供元が空なら warnOnOrganizationless が発火', r.status, 'violation');

state.settings = { ...DEFAULTS, warnOnOrganizationless: false };
r = T.evaluate(BUS, {
    login: 'dev', copilot_plan: 'business', access_type_sku: 'copilot_for_business_seat',
    organization_login_list: []
}, undefined, 'dev');
eq('warnOnOrganizationless=false なら発火しない', r.status, 'ok');

// --- evaluate: 内部APIと公開APIの不一致 ---
state.settings = { ...DEFAULTS };
r = T.evaluate(IND, {
    login: 'dev', copilot_plan: 'business', access_type_sku: 'copilot_for_business_seat',
    organization_login_list: ['my-org']
}, undefined, 'dev');
eq('公開APIが個人なら内部APIがbusinessでも違反', r.status, 'violation');

// --- レビュー指摘の回帰テスト ---
// Issue 1: 内部APIが200でもフィールドが欠けている場合、矛盾する違反を出さない
state.settings = { ...DEFAULTS };
r = T.evaluate(BUS, { login: 'dev' }, undefined, 'dev');
eq('Issue1: 内部APIにプラン情報が無くても違反にしない', r.status, 'ok');
eq('Issue1: 補足で説明する', r.infos.some(i => i.includes('プラン情報が含まれていません')), true);

state.settings = { ...DEFAULTS };
r = T.evaluate(BUS, { login: 'dev', copilot_plan: null, access_type_sku: '' }, undefined, 'dev');
eq('Issue1: 空文字/nullでも違反にしない', r.status, 'ok');

// Issue 2: organization_login_list の「欠落」と「空配列」を区別する
state.settings = { ...DEFAULTS };
r = T.evaluate(BUS, { login: 'dev', copilot_plan: 'business' }, undefined, 'dev');
eq('Issue2: seatOrgs 欠落は warnOrgless を発火させない', r.status, 'ok');
eq('Issue2: 未評価である旨の補足', r.infos.some(i => i.includes('シート提供元が含まれていない')), true);

state.settings = { ...DEFAULTS };
r = T.evaluate(BUS, { login: 'dev', copilot_plan: 'business', organization_login_list: [] }, undefined, 'dev');
eq('Issue2: 空配列は従来どおり違反', r.status, 'violation');

// Issue 5: allowedPlans の設定ミスでフェイルオープンしない
state.settings = { ...DEFAULTS, allowedPlans: ['Business'] };
r = T.evaluate(IND, undefined, undefined, 'dev');
eq('Issue5: "Business"(大文字)でも個人プランを許可しない', r.status, 'violation');
state.settings = { ...DEFAULTS, allowedPlans: ['Business'] };
r = T.evaluate(BUS, undefined, undefined, 'dev');
eq('Issue5: "Business"(大文字)は business として扱う', r.status, 'ok');

state.settings = { ...DEFAULTS, allowedPlans: ['copilot_for_business_seat'] };
r = T.evaluate(IND, undefined, undefined, 'dev');
eq('Issue5: 未知の値で個人プランを許可しない', r.status, 'violation');
eq('Issue5: 未知の値を警告する', r.infos.some(i => i.includes('認識できない値')), true);

state.settings = { ...DEFAULTS, allowedPlans: [] };
r = T.evaluate(BUS, undefined, undefined, 'dev');
eq('Issue5: 空の allowedPlans は何も許可しない', r.status, 'violation');

eq('Issue5: tierOfPlan 未知 -> unknown', T.tierOfPlan('copilot_for_business_seat'), 'unknown');
eq('Issue5: tierOfPlan 大文字許容', T.tierOfPlan('Business'), 'business');
eq('Issue5: tierOfPlan individual_pro_plus', T.tierOfPlan('individual_pro_plus'), 'individual');

// Issue 6: org 名の大小文字
state.settings = { ...DEFAULTS, requireOrganization: 'My-Org' };
r = T.evaluate(BUS, {
    login: 'dev', copilot_plan: 'business', organization_login_list: ['my-org']
}, undefined, 'dev');
eq('Issue6: org 名の大小文字を無視して照合', r.status, 'ok');

// --- 再レビュー指摘の回帰テスト ---
// 公開APIが使えない場合でも Free 確定シグナルを見逃さない
eq('新: free_limited_copilot を検出',
    T.internalFreeSignals({ access_type_sku: 'free_limited_copilot' }).length, 1);
eq('新: limited_user_quotas を検出',
    T.internalFreeSignals({ limited_user_quotas: { chat: 50 } }).length, 1);
eq('新: can_signup_for_limited を検出',
    T.internalFreeSignals({ can_signup_for_limited: true }).length, 1);
eq('新: 3シグナル同時',
    T.internalFreeSignals({
        access_type_sku: 'free_limited_copilot',
        limited_user_quotas: {}, can_signup_for_limited: true
    }).length, 3);
eq('新: Business ではシグナル無し',
    T.internalFreeSignals({
        access_type_sku: 'copilot_for_business_seat',
        organization_login_list: ['my-org'], can_signup_for_limited: false
    }).length, 0);
eq('新: limited_user_quotas=null はシグナルにしない',
    T.internalFreeSignals({ limited_user_quotas: null }).length, 0);
eq('新: 空応答ではシグナル無し', T.internalFreeSignals({}).length, 0);

// evaluate 経由でも同じシグナルが使われている（単一の真実の源）
state.settings = { ...DEFAULTS };
r = T.evaluate(BUS, { login: 'dev', copilot_plan: 'business', organization_login_list: ['o'], can_signup_for_limited: true }, undefined, 'dev');
eq('新: business でも can_signup_for_limited は違反', r.status, 'violation');

// --- 公開API判定不能(pub=undefined)時の縮退動作 ---
state.settings = { ...DEFAULTS };
r = T.evaluate(undefined, undefined, undefined, 'dev', 'HTTP 503');
eq('縮退: 内部APIも無ければ unknown', r.status, 'unknown');
eq('縮退: unknown でも ok にはしない', r.status === 'ok', false);
eq('縮退: note にエラーが入る', (r.note || '').includes('HTTP 503'), true);

state.settings = { ...DEFAULTS };
r = T.evaluate(undefined, {}, undefined, 'dev', 'HTTP 503');
eq('縮退: 内部API 200 だがプラン情報無し -> unknown', r.status, 'unknown');

// Issue B の本体: 有料個人プラン(Free シグナル無し)を見逃さない
state.settings = { ...DEFAULTS };
r = T.evaluate(undefined, { login: 'dev', copilot_plan: 'individual_pro', organization_login_list: ['o'] }, undefined, 'dev', 'HTTP 503');
eq('縮退: individual_pro を違反として検出', r.status, 'violation');
state.settings = { ...DEFAULTS };
r = T.evaluate(undefined, { login: 'dev', copilot_plan: 'individual_max', organization_login_list: ['o'] }, undefined, 'dev', 'HTTP 503');
eq('縮退: individual_max を違反として検出', r.status, 'violation');
state.settings = { ...DEFAULTS };
r = T.evaluate(undefined, { login: 'dev', access_type_sku: 'free_limited_copilot', organization_login_list: ['o'] }, undefined, 'dev', 'HTTP 503');
eq('縮退: Free を違反として検出', r.status, 'violation');

state.settings = { ...DEFAULTS };
r = T.evaluate(undefined, { login: 'dev', copilot_plan: 'business', organization_login_list: ['o'] }, undefined, 'dev', 'HTTP 503');
eq('縮退: business なら ok', r.status, 'ok');
eq('縮退: 主判定できなかった旨の補足', r.infos.some(i => i.includes('主判定ができませんでした')), true);
eq('縮退: apiEndpoint は空', r.apiEndpoint, '');

