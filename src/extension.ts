import * as vscode from 'vscode';

/**
 * プラン種別。公開 API (GraphQL `viewer.copilotEndpoints.api`) で判別できる粒度。
 * - business    : Copilot Business / Enterprise (法人シート)
 * - individual  : Copilot Free / Pro / Pro+ / Max (個人プラン)
 * 公開 API では business と enterprise、および free と pro/max は区別できない。
 */
type PlanTier = 'business' | 'individual' | 'unknown';

/** 公開 API のみで取得できる情報(主判定に使用) */
interface PublicInfo {
    login: string;
    apiEndpoint: string;
    tier: PlanTier;
}

/** GitHub 内部 API /copilot_internal/user のレスポンス(必要部分のみ)。詳細情報の補強にのみ使用。 */
interface CopilotUserInfo {
    login?: string;
    copilot_plan?: string;
    access_type_sku?: string;
    organization_login_list?: string[];
    can_signup_for_limited?: boolean;
    limited_user_quotas?: unknown;
    endpoints?: { api?: string };
}

interface Evaluation {
    status: 'ok' | 'violation' | 'unknown';
    plan: string;
    tier: PlanTier;
    sku: string;
    account: string;
    orgs: string[];
    /** orgs が「シート提供元」なら true、単なる所属組織なら false */
    orgsAuthoritative: boolean;
    apiEndpoint: string;
    /** 判定に使ったデータ源 */
    source: 'public' | 'public+internal';
    violations: string[];
    /** 違反ではないが利用者に伝えるべき補足(判定できなかった項目など) */
    infos: string[];
    note?: string;
}

/** requireOrganization の所属確認結果 */
type MembershipState = 'active' | 'pending' | 'none' | 'unverifiable';

interface OrgMembership {
    org: string;
    state: MembershipState;
    detail: string;
}

const GITHUB_GRAPHQL_API = 'https://api.github.com/graphql';
const GITHUB_API = 'https://api.github.com';
const COPILOT_USER_API = 'https://api.github.com/copilot_internal/user';

/** 公開 GraphQL: 自分の Copilot エンドポイント情報(公式スキーマに掲載されたフィールド) */
const QUERY_COPILOT_ENDPOINTS = '{ viewer { login copilotEndpoints { api } } }';

const USER_AGENT = 'CopilotLicenseGuard/1.2.0';

/**
 * Copilot が使う GitHub セッションを探すためのスコープ候補(広い順に試す)。
 *
 * ここに read:org を含む候補を置いてはならない。
 * 所属確認のための昇格サインインで別アカウントのセッションが作られた場合、
 * その候補が先に一致して「以後ずっと別アカウントを評価する」事故になるため。
 * read:org が要るときは、対象アカウントを固定したうえで個別に取得する。
 */
const SCOPE_CANDIDATES: string[][] = [
    ['read:user'],
    ['user:email'],
    []
];

/** business ティアとみなすプラン名 */
const BUSINESS_TIER_PLANS = ['business', 'enterprise'];
/** individual ティアとみなすプラン名 */
const INDIVIDUAL_TIER_PLANS = [
    'free', 'unauthenticated', 'individual',
    'individual_pro', 'individual_pro_plus', 'individual_max', 'individual_edu'
];

let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let timer: NodeJS.Timeout | undefined;
let lastEvaluation: Evaluation | undefined;
let warningOpen = false;
let checkRunning = false;
let debounceTimer: NodeJS.Timeout | undefined;
let extContext: vscode.ExtensionContext;

/** 連続発火するイベントをまとめて 1 回だけ検査する */
function scheduleCheck(delayMs = 1500): void {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        void runCheck(false);
    }, delayMs);
}

const CONSENT_KEY = 'copilotLicenseGuard.consentRequested';
/** 前回評価した GitHub アカウント(意図しない切替を検知するため保持する) */
const ACCOUNT_KEY = 'copilotLicenseGuard.lastAccountId';
const ACCOUNT_LABEL_KEY = 'copilotLicenseGuard.lastAccountLabel';

function log(message: string): void {
    // activate() 前や dispose 後に呼ばれても落ちないようにする
    if (!output) {
        return;
    }
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
               `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    output.appendLine(`${ts}  ${message}`);
}

function config() {
    return vscode.workspace.getConfiguration('copilotLicenseGuard');
}

/**
 * SKU 文字列からプラン名を導出する。
 * 既知 SKU は microsoft/vscode のソース由来。未知の SKU は 'unknown' として
 * 既定では許可外扱いになる (fail-safe)。
 */
function skuToPlan(sku: string | undefined): string {
    if (!sku) {
        return 'unknown';
    }
    const s = sku.toLowerCase();

    switch (s) {
        case 'free_limited_copilot': return 'free';
        case 'no_auth_limited_copilot': return 'unauthenticated';
        case 'copilot_enterprise_seat': return 'enterprise';
        case 'copilot_for_business_seat': return 'business';
        default: break;
    }

    // 判定順が重要: free / limited を先に見る
    if (/free|limited/.test(s)) { return 'free'; }
    if (/enterprise/.test(s)) { return 'enterprise'; }
    if (/business/.test(s)) { return 'business'; }
    if (/individual|subscriber|pro/.test(s)) { return 'individual'; }
    return 'unknown';
}

/**
 * Copilot API エンドポイントのホスト名からプラン種別を判定する。
 *
 * 実測値:
 *   Business  -> https://api.business.githubcopilot.com
 *   個人プラン -> https://api.individual.githubcopilot.com
 * 旧来の `api.githubcopilot.com` は個人扱いとする。
 *
 * 判定は githubcopilot.com 配下のサブドメインラベルの完全一致で行う。
 * `api.business.evil-githubcopilot.com` のようなサフィックス偽装や、
 * URL として解釈できない値は、すべて 'unknown'(=許可外) に倒す(fail-safe)。
 */
function tierFromApiEndpoint(api: string): PlanTier {
    if (!api) {
        return 'unknown';
    }

    let host: string;
    try {
        host = new URL(api).hostname.toLowerCase();
    } catch {
        // URL として解釈できない値は信用しない
        return 'unknown';
    }

    const suffix = '.githubcopilot.com';
    if (!host.endsWith(suffix)) {
        return 'unknown';
    }

    // 'api.business.githubcopilot.com' -> ['api', 'business']
    const labels = host.slice(0, -suffix.length).split('.');
    if (labels.includes('business') || labels.includes('enterprise')) {
        return 'business';
    }
    if (labels.includes('individual')) {
        return 'individual';
    }
    // 旧来の api.githubcopilot.com は個人/Free
    if (labels.length === 1 && labels[0] === 'api') {
        return 'individual';
    }
    return 'unknown';
}

/**
 * プラン名 -> プラン種別。
 * 既知の名前のみを明示的に対応付け、未知の名前は 'unknown' に倒す。
 * ここで未知を individual 等に丸めると、`allowedPlans` の設定ミス(例: "Business")が
 * 許可ティアの誤った拡大につながり、フェイルオープンになるため。
 */
function tierOfPlan(plan: string): PlanTier {
    const p = plan.trim().toLowerCase();
    if (BUSINESS_TIER_PLANS.includes(p)) {
        return 'business';
    }
    if (INDIVIDUAL_TIER_PLANS.includes(p)) {
        return 'individual';
    }
    return 'unknown';
}

function tierLabel(tier: PlanTier): string {
    switch (tier) {
        case 'business': return 'business/enterprise';
        case 'individual': return 'individual/free';
        default: return 'unknown';
    }
}

async function graphql<T>(token: string, query: string): Promise<{ data: T; errorText: string }> {
    const res = await fetch(GITHUB_GRAPHQL_API, {
        method: 'POST',
        headers: {
            'Authorization': `bearer ${token}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT
        },
        body: JSON.stringify({ query })
    });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    let json: { data?: T | null; errors?: { message?: string }[] };
    try {
        json = await res.json() as typeof json;
    } catch (err) {
        throw new Error(`GraphQL レスポンスを解析できませんでした: ${String(err)}`);
    }

    // 部分的な失敗(data はあるが errors も返る)を握り潰さないよう文字列化して返す
    const errorText = (json.errors ?? [])
        .map(e => e?.message ?? '(詳細不明)')
        .join(' / ');

    if (!json.data) {
        throw new Error(errorText || 'GraphQL レスポンスに data がありません');
    }
    return { data: json.data, errorText };
}

/**
 * 公開 GraphQL API で自分の Copilot エンドポイント情報を取得する(主判定)。
 * `User.copilotEndpoints` は GitHub が公開しているスキーマに掲載された正式なフィールド。
 *
 * エンドポイントを特定できなかった場合は例外にする。
 * 「取得できなかった」ことを違反(モーダル警告)ではなく「判定不能」として
 * 扱わせるため、ここで空文字を返してはならない。
 */
async function fetchPublicInfo(token: string): Promise<PublicInfo> {
    const { data, errorText } = await graphql<{
        viewer?: { login?: string; copilotEndpoints?: { api?: string } | null };
    }>(token, QUERY_COPILOT_ENDPOINTS);

    if (errorText) {
        log(`GraphQL からエラーが返りました: ${errorText}`);
    }

    const api = data.viewer?.copilotEndpoints?.api ?? '';
    if (!api) {
        throw new Error(
            `Copilot エンドポイント情報を取得できませんでした${errorText ? `: ${errorText}` : ''}`
        );
    }
    return {
        login: data.viewer?.login ?? '',
        apiEndpoint: api,
        tier: tierFromApiEndpoint(api)
    };
}

/**
 * セッションが Organization の所属を照会できる権限を持つか。
 *
 * 対象は `GET /user/memberships/orgs/{org}`(自分自身のメンバーシップを返す自己参照 API)で、
 * Organization owner 権限は不要。GitHub が返す
 * `X-Accepted-OAuth-Scopes: admin:org, read:org, repo, user, write:org` を実測して列挙している。
 * 権限が無いまま呼ぶと 404 が返り「非メンバー」と誤読しうるため、事前に確認する。
 */
const ORG_READ_SCOPES = ['admin:org', 'write:org', 'read:org', 'user', 'repo'];

function hasOrgScope(session: vscode.AuthenticationSession): boolean {
    return session.scopes.some(s => ORG_READ_SCOPES.includes(s));
}

/**
 * 公開 REST API で指定 Organization への所属だけをピンポイントに確認する。
 *
 * 一覧列挙 (GraphQL `viewer.organizations` / `GET /user/orgs`) を使わないのは、
 * IP 許可リストや SAML SSO が有効な組織が一覧から欠落し、
 * 「メンバーではない」と誤検知する恐れがあるため。
 * このエンドポイントは 404(非メンバー) と 403(確認不能) を区別できる。
 */
async function fetchOrgMembership(token: string, org: string): Promise<OrgMembership> {
    const url = `${GITHUB_API}/user/memberships/orgs/${encodeURIComponent(org)}`;
    const res = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': USER_AGENT
        }
    });

    if (res.status === 404) {
        return { org, state: 'none', detail: 'メンバーではありません' };
    }
    if (!res.ok) {
        // 403 は IP 許可リスト / SSO 未認可など。違反ではなく「確認不能」として扱う。
        return { org, state: 'unverifiable', detail: `HTTP ${res.status} ${res.statusText}` };
    }
    const json = await res.json() as { state?: string };
    if (json.state === 'active') {
        return { org, state: 'active', detail: 'active' };
    }
    return { org, state: 'pending', detail: json.state ?? '(不明)' };
}

/**
 * VS Code が保持する GitHub セッションを取得する。
 *
 * 注意: `silent: true` は「この拡張が既にアクセス許可を得ている場合のみ」返す。
 * 初回は必ず undefined になるため、一度だけ同意ダイアログ(`createIfNone`)を出す必要がある。
 */
async function getGitHubSession(allowPrompt: boolean): Promise<vscode.AuthenticationSession | undefined> {
    // 1) 許可済みならサイレントで取得(通常経路)
    for (const scopes of SCOPE_CANDIDATES) {
        try {
            const session = await vscode.authentication.getSession('github', scopes, { silent: true });
            if (session) {
                return session;
            }
        } catch (err) {
            log(`サイレント取得に失敗 (scopes=[${scopes.join(',')}]): ${String(err)}`);
        }
    }

    if (!allowPrompt) {
        return undefined;
    }

    // 2) 初回のみ同意を求める(以後はサイレントで取得できる)
    try {
        log('GitHub アカウントへのアクセス許可を要求します(初回のみ)。');
        await extContext.globalState.update(CONSENT_KEY, true);
        // ここで作るセッションのスコープは必ず SCOPE_CANDIDATES に含まれるものにする。
        // read:org を混ぜると、次回以降どの候補にも一致せず取得できなくなる。
        // 所属確認に必要な read:org は、対象アカウントを固定したうえで別途要求する。
        const session = await vscode.authentication.getSession(
            'github', SCOPE_CANDIDATES[0], { createIfNone: true }
        );
        if (session) {
            log(`アクセス許可を取得しました: ${session.account.label}`);
        }
        return session;
    } catch (err) {
        log(`アクセス許可の取得に失敗しました: ${String(err)}`);
        return undefined;
    }
}

/**
 * 非公式の内部 API で詳細情報を取得する(任意の補強)。
 * 失敗しても判定は公開 API の結果で成立するため、呼び出し側で握りつぶしてよい。
 */
async function fetchCopilotUser(token: string): Promise<CopilotUserInfo> {
    const res = await fetch(COPILOT_USER_API, {
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/json',
            'Editor-Version': `vscode/${vscode.version}`,
            'Editor-Plugin-Version': USER_AGENT,
            'User-Agent': USER_AGENT
        }
    });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as CopilotUserInfo;
}

/**
 * 内部 API の応答から「Free 確定」と言える決定的なシグナルを抽出する。
 * (microsoft/vscode の isFreeUser 相当)
 * 公開 API が使えない状況でも、これらが立っていれば見逃さずに警告する。
 */
function internalFreeSignals(internal: CopilotUserInfo): string[] {
    const signals: string[] = [];
    if (internal.access_type_sku === 'free_limited_copilot') {
        signals.push(`SKU が 'free_limited_copilot' = Copilot Free 確定です。`);
    }
    if (internal.limited_user_quotas !== undefined && internal.limited_user_quotas !== null) {
        signals.push('limited_user_quotas が設定されています = Free のクォータ制限下にあります。');
    }
    if (internal.can_signup_for_limited === true) {
        signals.push('can_signup_for_limited=true = 組織の Copilot シートが割り当てられていません。');
    }
    return signals;
}

/**
 * 取得済み情報を設定と突き合わせて違反を列挙する。
 *
 * 主判定は公開 API (`pub`) で行い、内部 API の結果 (`internal`) が得られた場合のみ
 * プラン名・SKU・シート提供元といった詳細な検査を追加する。
 *
 * `pub` が undefined(公開 API で判定できなかった)場合でも、内部 API だけで可能な
 * 判定は行う。検知能力を落とさないため、この縮退経路も同じ関数で扱い、
 * 判定ロジックが二重化しないようにする。
 */
function evaluate(
    pub: PublicInfo | undefined,
    internal: CopilotUserInfo | undefined,
    membership: OrgMembership | undefined,
    accountLabel: string,
    pubError?: string
): Evaluation {
    const cfg = config();
    const allowedRaw = cfg.get<string[]>('allowedPlans', ['business', 'enterprise']);
    const requireOrg = (cfg.get<string>('requireOrganization', '') || '').trim();
    const warnOrgless = cfg.get<boolean>('warnOnOrganizationless', true);

    const violations: string[] = [];
    const infos: string[] = [];

    const allowed = allowedRaw.map(p => (p ?? '').trim().toLowerCase()).filter(p => p);
    const unrecognized = allowed.filter(p => tierOfPlan(p) === 'unknown');
    if (unrecognized.length) {
        infos.push(`allowedPlans に認識できない値が含まれています(無視します): ${unrecognized.join(', ')}`);
    }

    const sku = internal?.access_type_sku ?? '';
    const rawPlan = (internal?.copilot_plan ?? '').trim().toLowerCase();
    // 内部 API が 200 でもフィールドが欠けている場合がある。
    // その場合にプラン名を 'unknown' へ丸めると公開 API の判定と矛盾する違反が出るため、
    // 「プラン情報あり」と「プラン情報なし」を明確に区別する。
    const hasPlanData = !!internal && (!!rawPlan || !!sku);
    const exactPlan = hasPlanData ? (rawPlan || skuToPlan(sku)) : '';
    const seatOrgs = internal?.organization_login_list;
    const tier = pub?.tier ?? 'unknown';
    const allowedTiers = new Set(allowed.map(tierOfPlan));

    // --- 1) 公開 API による主判定 -------------------------------------------
    if (!pub) {
        infos.push(
            `プラン種別の主判定ができませんでした${pubError ? ` (${pubError})` : ''}。` +
            '取得できた詳細情報の範囲で判定しています。'
        );
    } else if (tier === 'unknown') {
        violations.push(
            `Copilot API エンドポイントからプラン種別を判定できません: ${pub.apiEndpoint || '(未取得)'}`
        );
    } else if (!allowedTiers.has(tier)) {
        violations.push(
            tier === 'individual'
                ? `個人向け Copilot で動作しています (${pub.apiEndpoint})。組織シートが適用されていません。`
                : `使用中のプラン種別が許可外です: ${tier} (${pub.apiEndpoint})`
        );
    }

    // --- 2) 内部 API による詳細判定(任意) -----------------------------------
    if (internal) {
        if (!hasPlanData) {
            infos.push('詳細情報の応答にプラン情報が含まれていませんでした。主判定は公開 API の結果によります。');
        } else if (!allowed.includes(exactPlan)) {
            violations.push(`使用中のプランが許可外です: ${exactPlan}${sku ? ` (sku: ${sku})` : ''}`);
        }
        // Free 確定シグナル (microsoft/vscode の isFreeUser 相当)
        violations.push(...internalFreeSignals(internal));
        // seatOrgs が undefined = フィールド自体が無い(不明)。空配列(=シートなし)と区別する。
        if (warnOrgless && seatOrgs && seatOrgs.length === 0) {
            violations.push('organization_login_list が空です = 組織経由の Copilot を使用していません。');
        }
        if (warnOrgless && !seatOrgs) {
            infos.push('詳細情報の応答にシート提供元が含まれていないため warnOnOrganizationless は評価していません。');
        }
    } else {
        infos.push('プラン名・SKU・シート提供元は公開 API では取得できないため判定に含めていません。');
        if (warnOrgless) {
            infos.push('warnOnOrganizationless はシート提供元の情報が必要なため、このモードでは評価されません。');
        }
    }

    // --- 3) requireOrganization ---------------------------------------------
    if (requireOrg) {
        if (seatOrgs) {
            // GitHub の org login は大小文字を区別しないため正規化して比較する
            const wanted = requireOrg.toLowerCase();
            if (!seatOrgs.some(o => (o ?? '').toLowerCase() === wanted)) {
                violations.push(
                    `必須 Organization '${requireOrg}' にシートが紐づいていません (現在: ${seatOrgs.join(', ') || 'なし'})`
                );
            }
        } else if (membership) {
            switch (membership.state) {
                case 'active':
                    infos.push(
                        `'${requireOrg}' への所属は確認しましたが、公開 API では「その組織がシートを提供しているか」までは確認できません。`
                    );
                    break;
                case 'pending':
                    violations.push(
                        `必須 Organization '${requireOrg}' への参加が未完了です (state: ${membership.detail})。`
                    );
                    break;
                case 'none':
                    violations.push(`必須 Organization '${requireOrg}' のメンバーではありません。`);
                    break;
                default:
                    // IP 許可リスト / SSO 未認可など。誤検知を避けるため違反にはしない。
                    infos.push(
                        `必須 Organization '${requireOrg}' の所属を確認できませんでした: ${membership.detail}`
                    );
                    break;
            }
        } else {
            infos.push(
                `必須 Organization '${requireOrg}' の所属確認には read:org 権限が必要です。ステータスバーから再チェックすると許可を要求します。`
            );
        }
    }

    const orgs = seatOrgs ?? (membership?.state === 'active' ? [membership.org] : []);

    // 公開 API の主判定ができず、内部 API にもプラン情報が無い場合は
    // 「問題なし」と言い切れないため unknown にする(判定不能を OK と表示しない)。
    let status: Evaluation['status'];
    if (violations.length > 0) {
        status = 'violation';
    } else if (!pub && !hasPlanData) {
        status = 'unknown';
    } else {
        status = 'ok';
    }

    return {
        status,
        plan: exactPlan || tierLabel(tier),
        tier,
        sku,
        account: internal?.login || pub?.login || accountLabel,
        orgs,
        orgsAuthoritative: seatOrgs !== undefined,
        apiEndpoint: pub?.apiEndpoint ?? '',
        source: internal ? 'public+internal' : 'public',
        violations,
        infos,
        note: status === 'unknown'
            ? `ライセンス情報を取得できませんでした${pubError ? `: ${pubError}` : ''}`
            : undefined
    };
}

/** 判定不能時の Evaluation を組み立てる */
function unknownEvaluation(account: string, note: string): Evaluation {
    return {
        status: 'unknown',
        plan: 'unknown',
        tier: 'unknown',
        sku: '',
        account,
        orgs: [],
        orgsAuthoritative: false,
        apiEndpoint: '',
        source: 'public',
        violations: [],
        infos: [],
        note
    };
}

function updateStatusBar(ev: Evaluation | undefined): void {
    if (!config().get<boolean>('statusBar', true)) {
        statusBar.hide();
        return;
    }

    if (!ev || ev.status === 'unknown') {
        statusBar.text = '$(question) Copilot: 不明';
        statusBar.tooltip = ev?.note ?? 'Copilot ライセンスを判定できません';
        statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (ev.status === 'ok') {
        statusBar.text = `$(shield) Copilot: ${ev.plan}`;
        statusBar.tooltip = new vscode.MarkdownString(
            `**Copilot License Guard — OK**\n\n` +
            `- アカウント: \`${ev.account}\`\n` +
            `- プラン: \`${ev.plan}\`\n` +
            (ev.sku ? `- SKU: \`${ev.sku}\`\n` : '') +
            `- Organization: ${ev.orgs.map(o => `\`${o}\``).join(', ') || 'なし'}` +
            `${ev.orgs.length && !ev.orgsAuthoritative ? ' _(所属組織。シート提供元ではありません)_' : ''}\n` +
            `- API: \`${ev.apiEndpoint}\`\n` +
            `- 判定元: ${ev.source === 'public' ? '公開 API のみ' : '公開 API + 非公式 API'}\n` +
            (ev.infos.length ? `\n${ev.infos.map(i => `_${i}_`).join('\n\n')}\n` : '')
        );
        statusBar.backgroundColor = undefined;
    } else {
        statusBar.text = `$(alert) Copilot: ${ev.plan.toUpperCase()} 要確認`;
        statusBar.tooltip = new vscode.MarkdownString(
            `**⚠ Copilot ライセンス違反**\n\n` +
            ev.violations.map(v => `- ${v}`).join('\n') +
            `\n\nクリックで再チェック`
        );
        statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    statusBar.show();
}

async function showViolationWarning(ev: Evaluation): Promise<void> {
    if (warningOpen) {
        return;
    }
    warningOpen = true;
    try {
        const detail = [
            '意図した Copilot ライセンス(Business / Enterprise)で動作していない可能性があります。',
            'このまま使用すると、組織のコードが個人プランの条件で扱われる恐れがあります。',
            '',
            '── 検出された問題 ──',
            ...ev.violations.map(v => `• ${v}`),
            '',
            '── 現在の状態 ──',
            `アカウント : ${ev.account}`,
            `プラン     : ${ev.plan}`,
            ...(ev.sku ? [`SKU        : ${ev.sku}`] : []),
            `Organization : ${ev.orgs.join(', ') || 'なし'}` +
                `${ev.orgs.length && !ev.orgsAuthoritative ? ' (所属組織)' : ''}`,
            `API        : ${ev.apiEndpoint || '(不明)'}`,
            `判定元     : ${ev.source === 'public' ? '公開 API のみ' : '公開 API + 非公式 API'}`,
            ...(ev.infos.length ? ['', '── 補足 ──', ...ev.infos.map(i => `• ${i}`)] : []),
            '',
            '── 対処 ──',
            '1. 左下のアカウントアイコン → 該当アカウントをサインアウト',
            '2. 組織の GitHub アカウントで再サインイン',
            '3. コマンドパレット → "Developer: Reload Window"',
            '4. 再チェックして business になることを確認'
        ].join('\n');

        const useModal = config().get<boolean>('modalWarning', true);

        const choice = await vscode.window.showErrorMessage(
            '⚠ GitHub Copilot が意図したライセンスで動作していません',
            { modal: useModal, detail },
            'アカウントを切り替える',
            '再チェック',
            'ログを表示'
        );

        if (choice === 'アカウントを切り替える') {
            await openAccountManagement();
        } else if (choice === '再チェック') {
            await runCheck(true);
        } else if (choice === 'ログを表示') {
            output.show(true);
        }
    } finally {
        warningOpen = false;
    }
}

/** アカウント管理 UI を開く。コマンド名は VS Code のバージョンで異なるため順に試す。 */
async function openAccountManagement(): Promise<void> {
    const candidates = [
        'workbench.actions.manage',
        'workbench.action.manageTrustedExtensionsForAccount',
        'workbench.action.showAccountsMenu'
    ];
    for (const cmd of candidates) {
        try {
            await vscode.commands.executeCommand(cmd);
            return;
        } catch {
            // 次の候補へ
        }
    }
    void vscode.window.showInformationMessage(
        'VS Code 左下のアカウントアイコンをクリックし、GitHub アカウントをサインアウトしてから組織アカウントで再サインインしてください。'
    );
}

/**
 * ライセンスを検査する。
 * @param interactive true の場合、結果が OK でも通知を出す
 */
async function runCheck(interactive = false): Promise<void> {
    if (!config().get<boolean>('enabled', true)) {
        log('無効化されているためスキップします (copilotLicenseGuard.enabled = false)');
        statusBar.hide();
        return;
    }

    // 同時実行を防ぐ(セッション変更イベントは連続で複数回発火するため)
    if (checkRunning) {
        return;
    }

    let ev: Evaluation;

    // 手動実行時、または初回(まだ同意を求めていない)なら同意ダイアログを許可する
    const allowPrompt = interactive || !extContext.globalState.get<boolean>(CONSENT_KEY, false);

    checkRunning = true;
    try {
        const session = await getGitHubSession(allowPrompt);
        if (!session) {
            ev = unknownEvaluation(
                '(未サインイン)',
                'GitHub アカウントへのアクセスが許可されていません。ステータスバーの項目をクリックして許可してください。'
            );
            log('GitHub セッションを取得できませんでした。');
        } else {
            const token = session.accessToken;

            // 主判定: 公開 GraphQL API。
            let pub: PublicInfo | undefined;
            let pubError = '';
            try {
                pub = await fetchPublicInfo(token);
                log(`公開 API: login=${pub.login} endpoint=${pub.apiEndpoint} tier=${pub.tier}`);
            } catch (err) {
                pubError = String(err);
                log(`公開 API で Copilot エンドポイントを取得できませんでした: ${pubError}`);
            }

            // 補強: 非公式 API(任意)。失敗しても公開 API の判定で続行する。
            let internal: CopilotUserInfo | undefined;
            if (config().get<boolean>('useInternalApi', true)) {
                try {
                    internal = await fetchCopilotUser(token);
                } catch (err) {
                    log(`詳細情報の取得に失敗しました(判定は公開 API のみで継続します): ${String(err)}`);
                }
            }

            if (!pub) {
                // 公開 API で種別を判定できなくても、内部 API だけで可能な判定は行う。
                // 判定ロジックは evaluate() に一本化して二重化を避ける。
                log('公開 API の主判定なしで、取得できた詳細情報のみで評価します。');
            }

            // requireOrganization を公開 API だけで確認する必要がある場合のみ所属を照会する
            let membership: OrgMembership | undefined;
            const requireOrg = (config().get<string>('requireOrganization', '') || '').trim();
            if (requireOrg && !internal?.organization_login_list) {
                let orgSession = hasOrgScope(session) ? session : undefined;

                // 過去に昇格済みなら、同一アカウントに固定して黙って再利用する
                // (毎回同意ダイアログを出さないため)。
                if (!orgSession) {
                    try {
                        const cached = await vscode.authentication.getSession(
                            'github', ['read:user', 'read:org'],
                            { silent: true, account: session.account }
                        );
                        if (cached && cached.account.id === session.account.id) {
                            orgSession = cached;
                        }
                    } catch (err) {
                        log(`既存の read:org セッションの確認に失敗しました: ${String(err)}`);
                    }
                }

                // 無ければ手動チェック時に限り昇格を要求する。
                //
                // 重要: サインインフローで別アカウントが選ばれると、そのセッションが
                // 以降のチェックで拾われ「別人のプランを評価して緑を出し続ける」事故になる。
                // account を固定したうえで、返ってきたアカウントも必ず検証する。
                if (!orgSession && interactive) {
                    try {
                        log(`'${requireOrg}' の所属確認のため read:org 権限を要求します。`);
                        const upgraded = await vscode.authentication.getSession(
                            'github', ['read:user', 'read:org'],
                            { createIfNone: true, account: session.account }
                        );
                        if (!upgraded) {
                            log('read:org 権限の取得はキャンセルされました。');
                        } else if (upgraded.account.id !== session.account.id) {
                            log(
                                '権限昇格で別アカウントが選択されたため使用しません ' +
                                `(判定対象: ${session.account.label} / 選択: ${upgraded.account.label})。`
                            );
                        } else {
                            orgSession = upgraded;
                        }
                    } catch (err) {
                        log(`read:org 権限の取得に失敗しました: ${String(err)}`);
                    }
                }

                if (orgSession && hasOrgScope(orgSession)) {
                    try {
                        membership = await fetchOrgMembership(orgSession.accessToken, requireOrg);
                        log(`所属確認: ${requireOrg} -> ${membership.state} (${membership.detail})`);
                    } catch (err) {
                        membership = { org: requireOrg, state: 'unverifiable', detail: String(err) };
                        log(`所属確認に失敗しました: ${String(err)}`);
                    }
                } else {
                    // 権限が無いまま照会すると 404 を「非メンバー」と誤認しうるため実行しない
                    log(`所属を照会できる権限が無いため '${requireOrg}' の確認をスキップしました。`);
                }
            }

            ev = evaluate(pub, internal, membership, session.account.label, pubError || undefined);

            // 評価対象アカウントが前回から変わっていたら記録する
            // (意図しないアカウント切替を検知できるようにするため)
            const prevId = extContext.globalState.get<string>(ACCOUNT_KEY);
            if (prevId && prevId !== session.account.id) {
                const prevLabel = extContext.globalState.get<string>(ACCOUNT_LABEL_KEY) ?? '(不明)';
                const msg = `評価対象の GitHub アカウントが前回から変わりました: ${prevLabel} -> ${session.account.label}`;
                log(msg);
                ev.infos.push(msg);
            }
            void extContext.globalState.update(ACCOUNT_KEY, session.account.id);
            void extContext.globalState.update(ACCOUNT_LABEL_KEY, session.account.label);

            // VS Code のサインインアカウントと API 応答のアカウントが食い違う場合も事故
            const apiLogin = pub?.login || internal?.login;
            if (apiLogin && session.account.label &&
                apiLogin.toLowerCase() !== session.account.label.toLowerCase()) {
                ev.violations.push(
                    `アカウント不一致: VS Code='${session.account.label}' / API='${apiLogin}'`
                );
                ev.status = 'violation';
            }
        }
    } catch (err) {
        ev = unknownEvaluation('(取得失敗)', `ライセンス情報を取得できませんでした: ${String(err)}`);
        log(`エラー: ${String(err)}`);
    } finally {
        // UI 表示前に解放する(モーダル表示中の再チェック要求をブロックしないため)
        checkRunning = false;
    }

    lastEvaluation = ev;
    updateStatusBar(ev);

    if (ev.status === 'ok') {
        log(`OK  account=${ev.account} plan=${ev.plan} sku=${ev.sku || '-'} orgs=[${ev.orgs.join(',')}] source=${ev.source}`);
        ev.infos.forEach(i => log(`  (補足) ${i}`));
        if (interactive) {
            void vscode.window.showInformationMessage(
                `✅ Copilot は ${ev.plan} ライセンスで動作しています (${ev.account} / ${ev.orgs.join(', ') || '組織なし'})`
            );
        }
    } else if (ev.status === 'violation') {
        log(`VIOLATION  account=${ev.account} plan=${ev.plan} sku=${ev.sku || '-'} source=${ev.source}`);
        ev.violations.forEach(v => log(`  - ${v}`));
        ev.infos.forEach(i => log(`  (補足) ${i}`));
        await showViolationWarning(ev);
    } else {
        log(`UNKNOWN  ${ev.note ?? ''}`);
        if (interactive) {
            void vscode.window.showWarningMessage(`Copilot ライセンスを判定できません: ${ev.note ?? ''}`);
        } else if (!extContext.globalState.get<boolean>(CONSENT_KEY, false)) {
            void vscode.window.showWarningMessage(
                'Copilot License Guard: ライセンス確認のため GitHub アカウントへのアクセス許可が必要です。',
                'アクセスを許可'
            ).then(pick => {
                if (pick === 'アクセスを許可') {
                    void runCheck(true);
                }
            });
        }
    }
}

function restartTimer(context: vscode.ExtensionContext): void {
    if (timer) {
        clearInterval(timer);
        timer = undefined;
    }
    const minutes = Math.max(5, config().get<number>('checkIntervalMinutes', 30));
    timer = setInterval(() => { void runCheck(false); }, minutes * 60 * 1000);
    context.subscriptions.push({ dispose: () => { if (timer) { clearInterval(timer); } } });
    log(`再チェック間隔: ${minutes} 分`);
}

export function activate(context: vscode.ExtensionContext): void {
    extContext = context;
    output = vscode.window.createOutputChannel('Copilot License Guard');
    context.subscriptions.push(output);

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'copilotLicenseGuard.check';
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        vscode.commands.registerCommand('copilotLicenseGuard.check', () => runCheck(true)),
        vscode.commands.registerCommand('copilotLicenseGuard.showLog', () => output.show(true))
    );

    // アカウントが切り替わった瞬間に再検査する(意図せず Free の最頻出原因を即検知)
    context.subscriptions.push(
        vscode.authentication.onDidChangeSessions(e => {
            if (e.provider.id === 'github') {
                log('GitHub セッションの変更を検出しました。再チェックします。');
                scheduleCheck();
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('copilotLicenseGuard')) {
                log('設定変更を検出しました。再チェックします。');
                updateStatusBar(lastEvaluation);
                restartTimer(context);
                scheduleCheck(500);
            }
        })
    );

    log('Copilot License Guard を起動しました。');
    log('プラン種別の判定には GitHub の公開 GraphQL API (viewer.copilotEndpoints) を使用します。');
    if (config().get<boolean>('useInternalApi', true)) {
        log('注意: 詳細情報(プラン名/SKU/シート提供元)の取得に、GitHub 公式にサポートされていない ' +
            'エンドポイント /copilot_internal/user を併用します。' +
            '不要な場合は設定 copilotLicenseGuard.useInternalApi を false にしてください。');
    } else {
        log('詳細情報の取得(非公式 API)は無効です。公開 API のみで判定します。');
    }
    restartTimer(context);
    void runCheck(false);
}

export function deactivate(): void {
    if (timer) {
        clearInterval(timer);
        timer = undefined;
    }
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
    }
    lastEvaluation = undefined;
}
