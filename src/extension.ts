import * as vscode from 'vscode';
import * as os from 'os';
import { createHash, randomUUID } from 'crypto';

/**
 * プラン種別。公開 API (GraphQL `viewer.copilotEndpoints.api`) で判別できる粒度。
 * - business    : Copilot Business / Enterprise (法人シート)
 * - individual  : Copilot Free / Student / Pro / Pro+ / Max (個人プラン)
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

/**
 * 違反の機械可読コード。レポート送信の dedupe と、遮断(enforcement)の根拠判定に使う。
 * 文言(violations)は人向け、コードはプログラム向けに分離して保つ。
 */
type ViolationCode =
    | 'endpoint_unknown'            // 公開 API のエンドポイントから種別を判定できない(未知の値)
    | 'individual_tier'             // 公開 API が個人向けエンドポイント
    | 'tier_not_allowed'            // 種別は判定できたが allowedPlans に無い(business を許可していない等)
    | 'individual_plan'             // 内部 API のプラン名が既知の個人プラン
    | 'plan_not_allowed'            // 内部 API のプラン名が allowedPlans に無い(未知の名前を含む)
    | 'free_sku'                    // SKU が free_limited_copilot
    | 'free_quota'                  // limited_user_quotas あり
    | 'no_seat'                     // can_signup_for_limited = true
    | 'no_seat_org'                 // organization_login_list が空
    | 'required_org_seat_mismatch'  // シート提供元に必須 Organization が含まれない
    | 'org_not_member'              // 必須 Organization の非メンバー(404)
    | 'org_pending'                 // 必須 Organization への参加が未完了
    | 'account_mismatch';           // VS Code のアカウントと API 応答のアカウントが異なる

/**
 * 遮断(enforcement)の根拠にしてよい「明確な証拠」。
 * 未知のエンドポイント/SKU/プラン名や allowedPlans の設定ミスによる違反は、警告には倒す(fail-safe)が
 * 遮断の根拠にはしない。GitHub 側の文字列変更 1 つで全端末の AI 機能が止まる事故を避けるため。
 */
const STRONG_VIOLATION_CODES: ReadonlySet<ViolationCode> = new Set<ViolationCode>([
    'individual_tier', 'individual_plan', 'free_sku', 'free_quota', 'no_seat',
    'required_org_seat_mismatch', 'org_not_member', 'account_mismatch'
]);

function hasStrongViolation(codes: readonly ViolationCode[]): boolean {
    return codes.some(c => STRONG_VIOLATION_CODES.has(c));
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
    /** violations と対になる機械可読コード */
    codes: ViolationCode[];
    /** 違反ではないが利用者に伝えるべき補足(判定できなかった項目など) */
    infos: string[];
    /** requireOrganization の照合結果(未設定なら null) */
    requiredOrgMatch: boolean | null;
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

/**
 * HTTP リクエストの User-Agent。activate() で package.json の version から組み立てる
 * (バージョンをここにハードコードすると更新漏れが起きるため)。
 */
let userAgent = 'CopilotLicenseGuard/unknown';
let extensionVersion = 'unknown';

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
    const exact = skuToPlanExact(sku);
    if (exact !== undefined) {
        return exact;
    }
    const s = (sku ?? '').toLowerCase();
    if (!s) {
        return 'unknown';
    }

    // 判定順が重要: free / limited を先に見る。ここは推測(ヒューリスティック)なので
    // 警告の根拠にはするが、遮断の「明確な証拠」には使わない(evaluate 側で区別する)。
    if (/free|limited/.test(s)) { return 'free'; }
    if (/enterprise/.test(s)) { return 'enterprise'; }
    if (/business/.test(s)) { return 'business'; }
    if (/individual|subscriber|pro/.test(s)) { return 'individual'; }
    return 'unknown';
}

/** 既知 SKU の完全一致だけでプラン名を返す。一致しなければ undefined。 */
function skuToPlanExact(sku: string | undefined): string | undefined {
    switch ((sku ?? '').toLowerCase()) {
        case 'free_limited_copilot': return 'free';
        case 'no_auth_limited_copilot': return 'unauthenticated';
        case 'free_educational_quota': return 'individual_edu';
        case 'copilot_enterprise_seat': return 'enterprise';
        case 'copilot_for_business_seat': return 'business';
        case 'copilot_for_business_seat_quota': return 'business';
        default: return undefined;
    }
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
            'User-Agent': userAgent
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
            'User-Agent': userAgent
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
            'Editor-Plugin-Version': userAgent,
            'User-Agent': userAgent
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
function internalFreeSignals(internal: CopilotUserInfo): { code: ViolationCode; message: string }[] {
    const signals: { code: ViolationCode; message: string }[] = [];
    if (internal.access_type_sku === 'free_limited_copilot') {
        signals.push({ code: 'free_sku', message: `SKU が 'free_limited_copilot' = Copilot Free 確定です。` });
    }
    if (internal.limited_user_quotas !== undefined && internal.limited_user_quotas !== null) {
        signals.push({ code: 'free_quota', message: 'limited_user_quotas が設定されています = Free のクォータ制限下にあります。' });
    }
    if (internal.can_signup_for_limited === true) {
        signals.push({ code: 'no_seat', message: 'can_signup_for_limited=true = 組織の Copilot シートが割り当てられていません。' });
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
    const codes: ViolationCode[] = [];
    const infos: string[] = [];
    const violate = (code: ViolationCode, message: string) => { violations.push(message); codes.push(code); };

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
        violate('endpoint_unknown',
            `Copilot API エンドポイントからプラン種別を判定できません: ${pub.apiEndpoint || '(未取得)'}`);
    } else if (!allowedTiers.has(tier)) {
        if (tier === 'individual') {
            violate('individual_tier',
                `個人向け Copilot で動作しています (${pub.apiEndpoint})。組織シートが適用されていません。`);
        } else {
            violate('tier_not_allowed', `使用中のプラン種別が許可外です: ${tier} (${pub.apiEndpoint})`);
        }
    }

    // --- 2) 内部 API による詳細判定(任意) -----------------------------------
    if (internal) {
        if (!hasPlanData) {
            infos.push('詳細情報の応答にプラン情報が含まれていませんでした。主判定は公開 API の結果によります。');
        } else if (!allowed.includes(exactPlan)) {
            // 「明確な証拠」は、内部 API が返した既知の個人プラン名、または既知 SKU の完全一致に限る。
            // SKU の部分一致(ヒューリスティック)で individual/free に丸めた結果は警告どまり。
            const knownIndividual = rawPlan
                ? tierOfPlan(rawPlan) === 'individual'
                : tierOfPlan(skuToPlanExact(sku) ?? '') === 'individual';
            violate(knownIndividual ? 'individual_plan' : 'plan_not_allowed',
                `使用中のプランが許可外です: ${exactPlan}${sku ? ` (sku: ${sku})` : ''}`);
        }
        // Free 確定シグナル (microsoft/vscode の isFreeUser 相当)
        for (const s of internalFreeSignals(internal)) {
            violate(s.code, s.message);
        }
        // seatOrgs が undefined = フィールド自体が無い(不明)。空配列(=シートなし)と区別する。
        if (warnOrgless && seatOrgs && seatOrgs.length === 0) {
            violate('no_seat_org', 'organization_login_list が空です = 組織経由の Copilot を使用していません。');
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
    let requiredOrgMatch: boolean | null = null;
    if (requireOrg) {
        if (seatOrgs) {
            // GitHub の org login は大小文字を区別しないため正規化して比較する
            const wanted = requireOrg.toLowerCase();
            requiredOrgMatch = seatOrgs.some(o => (o ?? '').toLowerCase() === wanted);
            if (!requiredOrgMatch) {
                // 空配列なら no_seat_org 側で扱う。非空で含まれない = 別組織のシートが「明確」
                violate(seatOrgs.length ? 'required_org_seat_mismatch' : 'no_seat_org',
                    `必須 Organization '${requireOrg}' にシートが紐づいていません (現在: ${seatOrgs.join(', ') || 'なし'})`);
            }
        } else if (membership) {
            switch (membership.state) {
                case 'active':
                    requiredOrgMatch = true;
                    infos.push(
                        `'${requireOrg}' への所属は確認しましたが、公開 API では「その組織がシートを提供しているか」までは確認できません。`
                    );
                    break;
                case 'pending':
                    requiredOrgMatch = false;
                    violate('org_pending',
                        `必須 Organization '${requireOrg}' への参加が未完了です (state: ${membership.detail})。`);
                    break;
                case 'none':
                    requiredOrgMatch = false;
                    violate('org_not_member', `必須 Organization '${requireOrg}' のメンバーではありません。`);
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
        codes,
        infos,
        requiredOrgMatch,
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
        codes: [],
        infos: [],
        requiredOrgMatch: null,
        note
    };
}

// ===========================================================================
// 遮断(enforcement) — 違反時に VS Code の公式設定 chat.disableAIFeatures を
// ユーザー設定へ書き、違反解消で元に戻す(試験版機能・既定 OFF)
// ===========================================================================

const ENFORCE_KEY = 'copilotLicenseGuard.enforce';
const AI_DISABLE_SETTING = 'chat.disableAIFeatures';
const SYNC_IGNORE_SETTING = 'settingsSync.ignoredSettings';
/** 設定を切り替えるたびに拡張ホストが再起動するため、短時間の往復(flapping)を抑える */
const ENFORCE_MIN_INTERVAL_MS = 5 * 60_000;
const ENFORCE_MAX_CHANGES_PER_HOUR = 4;
/** enforcementOnUnknown のとき、起動直後の一時的なネットワーク断で止めないための猶予 */
const ENFORCE_UNKNOWN_GRACE_MS = 15 * 60_000;
/** 複数ウィンドウが同時に書かないための所有権の有効期間 */
const ENFORCE_OWNER_TTL_MS = 60_000;

type EnforceMode = 'warn' | 'disableAI';
type EnforceState = 'idle' | 'applying' | 'active' | 'releasing';
type EnforceAction = 'none' | 'apply' | 'reapply' | 'restore';

/**
 * 遮断の記録。設定を書き換える**前**に globalState へ保存する。
 * chat.disableAIFeatures を変更すると VS Code が Copilot Chat を無効化して拡張ホストを再起動するため、
 * 書き換え後の処理は実行される保証がない。元値(saved)は idle からの適用時に一度だけ記録し、
 * それ以外では決して上書きしない(自分が書いた true を元値と誤認して復帰できなくなる事故の防止)。
 */
interface EnforceJournal {
    state: EnforceState;
    /** 適用前の chat.disableAIFeatures の globalValue。null = 未設定だった */
    saved: boolean | null;
    /** 設定を書き換えた時刻(ISO)。直近 1 時間分だけ保持し flapping 判定に使う */
    changes: string[];
    owner?: string;
    ownerAt?: string;
    /** 手動停止(コマンド)の期限 */
    suspendedUntil?: string;
    /** 判定不能が続いている開始時刻(enforcementOnUnknown の猶予判定) */
    unknownSince?: string;
    appliedAt?: string;
    lastError?: string;
    /** 設定を書く前に記録し、送信できたら消す(拡張ホスト再起動で enforcement イベントが落ちないように) */
    pendingReport?: { action: EnforceAction; reason: string; at: string; claimedBy?: string; claimedAt?: string };
    /** 適用時点で読み込まれていた拡張の ID。復帰後に無効のまま残った依存拡張(VS Code が Copilot Chat と一緒に無効化したもの)を見つけるため */
    extensionsBefore?: string[];
    /** 復元した時刻。これが残っている間は、次の機会に extensionsBefore と現状を比べて通知する */
    restoredAt?: string;
}

const IDLE_JOURNAL: EnforceJournal = { state: 'idle', saved: null, changes: [] };

interface EnforcePlanInput {
    mode: EnforceMode;
    guardEnabled: boolean;
    status: Evaluation['status'];
    codes: readonly ViolationCode[];
    onUnknown: boolean;
    journal: EnforceJournal;
    /** 現在の chat.disableAIFeatures の globalValue(undefined = 未設定) */
    globalValue: boolean | undefined;
    now: number;
}

interface EnforcePlan {
    action: EnforceAction;
    reason: string;
    /** changes の期限切れ掃除と unknownSince の更新を反映した journal(保存は呼び出し側) */
    journal: EnforceJournal;
    /** 遮断すべき状態か(action が none でも維持中なら true) */
    wantBlock: boolean;
}

/**
 * 遮断の状態遷移(純粋関数)。
 * - 遮断の根拠は STRONG_VIOLATION_CODES に限る
 * - unknown は既定で「現状維持」(fail-safe: 復帰は ok を確認してから)。enforcementOnUnknown なら猶予後に適用
 * - mode が warn / 拡張が無効 / 手動停止中 なら、適用中であれば必ず復元する
 * - flapping 防止: 適用/再適用は前回変更から 5 分、全操作で 1 時間 4 回まで
 */
function planEnforcement(i: EnforcePlanInput): EnforcePlan {
    const j: EnforceJournal = {
        ...i.journal,
        changes: (i.journal.changes ?? []).filter(t => i.now - Date.parse(t) < 3_600_000)
    };
    const active = j.state !== 'idle';
    // 「遮断を維持すべき状態」は active / applying のみ。releasing(復元の途中で中断)は復元を完了させる側に倒す
    const blocking = j.state === 'active' || j.state === 'applying';
    const suspended = !!j.suspendedUntil && Date.parse(j.suspendedUntil) > i.now;
    if (!suspended) {
        delete j.suspendedUntil;
    }
    if (i.status !== 'unknown') {
        delete j.unknownSince;
    }

    let wantBlock = false;
    let reason = '';
    if (i.mode !== 'disableAI') {
        reason = 'enforcement=warn';
    } else if (!i.guardEnabled) {
        reason = 'guard disabled';
    } else if (suspended) {
        reason = `suspended until ${j.suspendedUntil}`;
    } else if (i.status === 'violation') {
        wantBlock = hasStrongViolation(i.codes);
        reason = wantBlock ? 'strong violation' : 'violation without strong evidence';
    } else if (i.status === 'unknown') {
        if (!i.onUnknown) {
            wantBlock = blocking;
            reason = blocking ? 'unknown: keep enforced (fail-safe)' : 'unknown: not enforcing';
        } else {
            const since = j.unknownSince ? Date.parse(j.unknownSince) : i.now;
            if (!j.unknownSince) {
                j.unknownSince = new Date(i.now).toISOString();
            }
            wantBlock = blocking || (i.now - since >= ENFORCE_UNKNOWN_GRACE_MS);
            reason = wantBlock ? 'unknown beyond grace period' : 'unknown within grace period';
        }
    } else {
        reason = 'ok';
    }

    let action: EnforceAction = 'none';
    if (wantBlock) {
        if (!active) {
            action = 'apply';
        } else if (i.globalValue !== true) {
            action = 'reapply';
        }
    } else if (active) {
        action = 'restore';
    }

    if (action !== 'none') {
        const last = j.changes.length ? Date.parse(j.changes[j.changes.length - 1]) : 0;
        if (j.changes.length >= ENFORCE_MAX_CHANGES_PER_HOUR) {
            return { action: 'none', reason: `flapping: ${j.changes.length} changes in the last hour`, journal: j, wantBlock };
        }
        if (action !== 'restore' && i.now - last < ENFORCE_MIN_INTERVAL_MS) {
            return { action: 'none', reason: 'cooldown after recent change', journal: j, wantBlock };
        }
    }
    return { action, reason, journal: j, wantBlock };
}

type OverrideLayer = 'workspaceFolder' | 'workspace' | 'other' | null;

interface EnforceOutcome {
    action: EnforceAction;
    result: 'done' | 'skipped' | 'failed' | 'unsupported';
    reason: string;
    /** 現在、遮断の記録が有効(idle 以外)か */
    active: boolean;
    /** 遮断中なのに実効値が true でない場合、どの層が上書きしているか */
    overriddenBy: OverrideLayer;
}

function enforceMode(): EnforceMode {
    return config().get<string>('enforcement', 'warn') === 'disableAI' ? 'disableAI' : 'warn';
}

function readJournal(): EnforceJournal {
    const j = extContext.globalState.get<EnforceJournal>(ENFORCE_KEY);
    return j && typeof j === 'object' && j.state ? { ...IDLE_JOURNAL, ...j, changes: j.changes ?? [] } : { ...IDLE_JOURNAL };
}

async function writeJournal(j: EnforceJournal): Promise<void> {
    await extContext.globalState.update(ENFORCE_KEY, j);
}

/** 遮断状態が利用者の他端末へ同期されないよう、対象設定を Settings Sync の除外に入れる(自動では外さない) */
async function ensureSyncIgnored(): Promise<void> {
    try {
        const cfg = vscode.workspace.getConfiguration();
        const current = cfg.inspect<string[]>(SYNC_IGNORE_SETTING)?.globalValue ?? [];
        if (!current.includes(AI_DISABLE_SETTING)) {
            await cfg.update(SYNC_IGNORE_SETTING, [...current, AI_DISABLE_SETTING], vscode.ConfigurationTarget.Global);
            log(`Settings Sync の除外に ${AI_DISABLE_SETTING} を追加しました。`);
        }
    } catch (err) {
        log(`Settings Sync の除外設定を更新できませんでした: ${sanitizeError(err)}`);
    }
}

function detectOverride(insp: ReturnType<vscode.WorkspaceConfiguration['inspect']> | undefined, effective: boolean | undefined): OverrideLayer {
    if (effective === true) {
        return null;
    }
    const i = insp as { workspaceFolderValue?: unknown; workspaceValue?: unknown } | undefined;
    if (i?.workspaceFolderValue === false) {
        return 'workspaceFolder';
    }
    if (i?.workspaceValue === false) {
        return 'workspace';
    }
    return 'other';
}

/** エラー文字列から URL らしきものを落とす(ログに送信先やクエリを残さない) */
function sanitizeError(err: unknown): string {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return msg.replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);
}

/**
 * 判定結果に応じて遮断を適用/再適用/復元する。guardEnabled=false は「拡張が無効化された」経路で、
 * 適用中なら必ず復元する(runCheck の早期 return で遮断が取り残されないようにするため)。
 */
/** この VS Code に chat.disableAIFeatures が登録されているか(1.104 未満では未登録で update() が失敗する) */
function aiDisableSettingSupported(): boolean {
    const insp = vscode.workspace.getConfiguration().inspect<boolean>(AI_DISABLE_SETTING);
    return insp !== undefined && insp.defaultValue !== undefined;
}

async function enforce(ev: Evaluation, guardEnabled: boolean): Promise<EnforceOutcome> {
    const mode = enforceMode();
    const journal = readJournal();
    const cfg = vscode.workspace.getConfiguration();
    const insp = cfg.inspect<boolean>(AI_DISABLE_SETTING);
    const globalValue = insp?.globalValue;
    const now = Date.now();

    const plan = planEnforcement({
        mode, guardEnabled, status: ev.status, codes: ev.codes,
        onUnknown: config().get<boolean>('enforcementOnUnknown', false),
        journal, globalValue, now
    });
    let j = plan.journal;
    const effective = cfg.get<boolean>(AI_DISABLE_SETTING);
    const overriddenBy: OverrideLayer = (j.state !== 'idle' && globalValue === true) ? detectOverride(insp, effective) : null;

    if (plan.action === 'none') {
        if (JSON.stringify(j) !== JSON.stringify(journal)) {
            await writeJournal(j);
        }
        if (plan.reason.startsWith('flapping') || plan.reason.startsWith('cooldown')) {
            log(`遮断: 変更を見送りました (${plan.reason})`);
        }
        return { action: 'none', result: 'skipped', reason: plan.reason, active: j.state !== 'idle', overriddenBy };
    }

    // 未サポートの VS Code では書かない(書けば未知キーで失敗する)。適用中なら解除だけは試みる価値がないので記録を閉じる
    if (!aiDisableSettingSupported() && plan.action !== 'restore') {
        if (!journal.lastError) {
            await writeJournal({ ...j, lastError: 'unsupported' });
            log(`遮断: この VS Code (${vscode.version}) には ${AI_DISABLE_SETTING} が無いため遮断できません(1.104 以降が必要)。警告のみ行います。`);
        }
        return { action: plan.action, result: 'unsupported', reason: 'chat.disableAIFeatures is not registered', active: j.state !== 'idle', overriddenBy };
    }

    // 複数ウィンドウの同時書き込みを避ける(ベストエフォート)
    const me = vscode.env.sessionId;
    if (j.owner && j.owner !== me && j.ownerAt && now - Date.parse(j.ownerAt) < ENFORCE_OWNER_TTL_MS) {
        return { action: plan.action, result: 'skipped', reason: 'another window is applying', active: j.state !== 'idle', overriddenBy };
    }
    const stamp = new Date(now).toISOString();
    j = {
        ...j, owner: me, ownerAt: stamp, changes: [...j.changes, stamp],
        // 設定を書く前に「送るべきイベント」を記録しておく(書いた直後に拡張ホストが再起動しても次回チェックで送れる)
        pendingReport: { action: plan.action, reason: plan.reason, at: stamp }
    };

    try {
        if (plan.action === 'apply' || plan.action === 'reapply') {
            if (plan.action === 'apply') {
                // 元値は idle からの適用時にだけ記録する(以後は上書きしない)。
                // 読み込まれている拡張も記録する: VS Code は chat.disableAIFeatures=true で Copilot Chat と
                // それに依存する拡張をまとめて無効化するが、解除時に戻すのは Copilot Chat だけなので、後で差分を利用者に知らせる。
                j = {
                    ...j, state: 'applying', saved: globalValue ?? null, appliedAt: stamp,
                    extensionsBefore: vscode.extensions.all.map(e => e.id), restoredAt: undefined
                };
            }
            await writeJournal(j);                 // ← 設定を書く前に必ず保存
            await ensureSyncIgnored();             // ← 値を書く前に Sync 除外へ
            await cfg.update(AI_DISABLE_SETTING, true, vscode.ConfigurationTarget.Global);
            j = { ...j, state: 'active', lastError: undefined };
            await writeJournal(j);
            log(`遮断: ${AI_DISABLE_SETTING} を true にしました (${plan.reason})`);
            return { action: plan.action, result: 'done', reason: plan.reason, active: true, overriddenBy: null };
        }

        // restore
        j = { ...j, state: 'releasing' };
        await writeJournal(j);
        if (cfg.inspect<boolean>(AI_DISABLE_SETTING)?.globalValue === true) {
            // 利用者が既に手で変えていたら触らない(元値の復元は自分が書いた true の上にだけ行う)
            await cfg.update(AI_DISABLE_SETTING, j.saved === null ? undefined : j.saved, vscode.ConfigurationTarget.Global);
        }
        j = {
            ...IDLE_JOURNAL, changes: j.changes, suspendedUntil: j.suspendedUntil, pendingReport: j.pendingReport,
            extensionsBefore: j.extensionsBefore, restoredAt: new Date().toISOString()
        };
        await writeJournal(j);
        log(`遮断: 解除しました (${plan.reason})`);
        // VS Code が Copilot Chat を再有効化し終えた頃に、無効のまま残った依存拡張を確認する
        // (拡張ホストが再起動した場合は activate() 側のタイマーが同じ処理を行う)
        setTimeout(() => { void notifyExtensionsLeftDisabled(); }, 30_000);
        return { action: 'restore', result: 'done', reason: plan.reason, active: false, overriddenBy: null };
    } catch (err) {
        const msg = sanitizeError(err);
        // レポートには分類だけ(VS Code のエラー文には settings.json のパス=OS ユーザー名が含まれうる)。全文はローカルのログにのみ残す
        const category = `failed: ${err instanceof Error ? err.name : 'Error'}`;
        if (plan.action === 'apply') {
            // 適用できなかったのに「停止中」と表示しないよう idle に戻す(変更時刻とエラーは残して backoff に使う)
            j = { ...IDLE_JOURNAL, changes: j.changes, suspendedUntil: j.suspendedUntil, lastError: msg,
                  pendingReport: { action: plan.action, reason: category, at: stamp } };
        } else {
            // reapply / restore の失敗は状態を保ち、次回チェックで再試行する
            j = { ...j, lastError: msg, pendingReport: { action: plan.action, reason: category, at: stamp } };
        }
        await writeJournal(j);
        log(`遮断: 設定の書き換えに失敗しました (${plan.action}): ${msg}`);
        return { action: plan.action, result: 'failed', reason: category, active: j.state !== 'idle', overriddenBy };
    }
}

/** 設定変更前に記録した enforcement イベントを送り、送れたら消す(拡張ホスト再起動後の回収も兼ねる) */
async function flushPendingEnforcementReport(ev: Evaluation | undefined): Promise<void> {
    const j = readJournal();
    const p = j.pendingReport;
    if (!p) {
        return;
    }
    // 複数ウィンドウが同じ記録を同時に送らないよう、先に自分の claim を書く(ベストエフォート)
    const me = vscode.env.sessionId;
    if (p.claimedBy && p.claimedBy !== me && p.claimedAt && Date.now() - Date.parse(p.claimedAt) < 60_000) {
        return;
    }
    await writeJournal({ ...j, pendingReport: { ...p, claimedBy: me, claimedAt: new Date().toISOString() } });
    const deferred = Date.now() - Date.parse(p.at) > 5_000;
    const ok = await sendReport('enforcement', ev, {
        enforcement: { action: p.action, reason: p.reason, at: p.at, deferred, active: j.state !== 'idle' }
    }, `enforcement:${p.at}`);
    // 送れた、または送る設定になっていない(URL 未設定/不正、enforcement イベントが無効)なら記録を消す。
    // 消さないと毎回 claim し直し、後で有効化されたときに古い出来事が deferred で送られてしまう
    const rs = readReportSettings();
    const reportable = !!rs.url && validateReportUrl(rs.url).ok && rs.events.includes('enforcement');
    if (ok || !reportable) {
        const latest = readJournal();
        if (latest.pendingReport && latest.pendingReport.at === p.at) {
            await writeJournal({ ...latest, pendingReport: undefined });
        }
    }
}

/**
 * 復帰後に無効のまま残った拡張を利用者に知らせる。
 * VS Code は chat.disableAIFeatures=true で Copilot Chat とそれに依存する拡張をまとめて無効化するが、
 * false に戻したときに再有効化するのは Copilot Chat だけ(実測: 1.143)。依存拡張は手で戻してもらうしかない。
 * 拡張ホストの再起動後(activate)と、再起動が無かった場合の次回チェックで 1 回だけ評価する。
 */
async function notifyExtensionsLeftDisabled(): Promise<void> {
    const j = readJournal();
    if (!j.restoredAt || !j.extensionsBefore) {
        return;
    }
    // 復元直後は VS Code 側の再有効化と拡張ホスト再起動が終わっていない可能性があるため少し待つ
    if (Date.now() - Date.parse(j.restoredAt) < 20_000) {
        return;
    }
    const now = new Set(vscode.extensions.all.map(e => e.id));
    const missing = j.extensionsBefore.filter(id => !now.has(id) && id.toLowerCase() !== 'kuro524.copilot-license-guard');
    const latest = readJournal();
    await writeJournal({ ...latest, extensionsBefore: undefined, restoredAt: undefined });
    if (!missing.length) {
        return;
    }
    log(`遮断の解除後、次の拡張が無効のままです(VS Code が Copilot Chat と一緒に無効化したもの): ${missing.join(', ')}`);
    void sendReport('enforcement', lastEvaluation, {
        enforcement: { action: 'post-restore', reason: 'extensions left disabled', active: false, disabledExtensionCount: missing.length }
    }, `enforcement:post-restore:${j.restoredAt}`);
    const pick = await vscode.window.showWarningMessage(
        `Copilot License Guard: 遮断の解除後、${missing.length} 件の拡張機能が無効のままです(${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' …' : ''})。` +
        'VS Code が Copilot Chat と一緒に無効化したもので、必要なら拡張機能ビューから有効化してください。',
        '無効な拡張機能を表示'
    );
    if (pick) {
        void vscode.commands.executeCommand('workbench.extensions.search', '@disabled');
    }
}
/** 手動停止/初期化コマンド。停止は期限付きで、次回チェックで違反が続けば期限後に再適用される。 */
async function suspendEnforcementCommand(): Promise<void> {
    const pick = await vscode.window.showQuickPick([
        { label: '60 分間 遮断を停止', minutes: 60 },
        { label: '180 分間 遮断を停止', minutes: 180 },
        { label: `遮断の記録を初期化して ${AI_DISABLE_SETTING} を未設定に戻す(復旧用)`, minutes: -1 }
    ], { placeHolder: 'Copilot License Guard: 遮断の手動操作(ログとレポートに記録されます)' });
    if (!pick) {
        return;
    }
    const j = readJournal();
    if (pick.minutes < 0) {
        try {
            await vscode.workspace.getConfiguration().update(AI_DISABLE_SETTING, undefined, vscode.ConfigurationTarget.Global);
        } catch (err) {
            log(`初期化: 設定の削除に失敗しました: ${sanitizeError(err)}`);
        }
        await writeJournal({ ...IDLE_JOURNAL });
        log('遮断: 記録を初期化しました(手動)。');
        void sendReport('enforcement', lastEvaluation, { enforcement: { action: 'reset', result: 'done', reason: 'manual reset', active: false, overriddenBy: null } }, `enforcement:reset:${new Date().toISOString()}`);
    } else {
        const until = new Date(Date.now() + pick.minutes * 60_000).toISOString();
        await writeJournal({ ...j, suspendedUntil: until });
        log(`遮断: ${pick.minutes} 分間停止します(手動)。期限: ${until}`);
        void sendReport('enforcement', lastEvaluation, { enforcement: { action: 'suspend', result: 'done', reason: `manual suspend ${pick.minutes}m`, active: j.state !== 'idle', overriddenBy: null } }, `enforcement:suspend:${until}`);
    }
    await runCheck(true);
}

// ===========================================================================
// 管理者向けレポート送信(試験版機能・既定 OFF)
// ===========================================================================

const REPORT_KEY = 'copilotLicenseGuard.report';
type ReportEvent = 'violation' | 'recovered' | 'unknown' | 'heartbeat' | 'enforcement' | 'monitoringDisabled' | 'test';
const ALL_REPORT_EVENTS: ReportEvent[] = ['violation', 'recovered', 'unknown', 'heartbeat', 'enforcement', 'monitoringDisabled'];
type DeviceField = 'hostname' | 'osUser' | 'installId';
/** 同じ違反を繰り返し送る間隔 */
const REPORT_REPEAT_MS = 24 * 3_600_000;
const REPORT_TIMEOUT_MS = 10_000;

interface ReportSettings {
    url: string;
    headers: Record<string, string>;
    format: 'json' | 'slack';
    events: ReportEvent[];
    heartbeatHours: number;
    deviceFields: DeviceField[];
}

interface ReportState {
    installId: string;
    seq: number;
    /** 最後に送信に成功したイベントの状態 */
    lastSentStatus?: string;
    lastSentKey?: string;
    lastSentAt?: string;
    /** 未解消の違反(violation を送ってから recovered を送るまで保持)。途中に unknown/disabled を挟んでも recovered を落とさない */
    openViolationKey?: string;
    lastViolationSentAt?: string;
    nextHeartbeatAt?: string;
    noticeShownFor?: string;
    backoffUntil?: string;
}

function readReportSettings(): ReportSettings {
    const cfg = config();
    const headersRaw = cfg.get<Record<string, unknown>>('report.headers', {}) ?? {};
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(headersRaw)) {
        if (typeof v === 'string' && /^[A-Za-z0-9-]+$/.test(k)) {
            headers[k] = v;
        }
    }
    const events = (cfg.get<string[]>('report.events', ALL_REPORT_EVENTS) ?? [])
        .filter((e): e is ReportEvent => (ALL_REPORT_EVENTS as string[]).includes(e));
    const deviceFields = (cfg.get<string[]>('report.deviceFields', ['hostname', 'installId']) ?? [])
        .filter((f): f is DeviceField => ['hostname', 'osUser', 'installId'].includes(f));
    return {
        url: (cfg.get<string>('report.url', '') || '').trim(),
        headers,
        format: cfg.get<string>('report.format', 'json') === 'slack' ? 'slack' : 'json',
        events,
        heartbeatHours: Math.max(1, Number(cfg.get<number>('report.heartbeatHours', 24)) || 24),
        deviceFields
    };
}

/** 送信先 URL の検証。https 必須(localhost のみ http 可)、認証情報入り URL は拒否。 */
function validateReportUrl(url: string): { ok: true; host: string } | { ok: false; reason: string } {
    if (!url) {
        return { ok: false, reason: 'empty' };
    }
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return { ok: false, reason: 'URL として解釈できません' };
    }
    if (u.username || u.password) {
        return { ok: false, reason: 'URL に認証情報を含めないでください(report.headers を使用)' };
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
        return { ok: false, reason: 'https:// のみ使用できます(localhost を除く)' };
    }
    return { ok: true, host: u.host };
}

interface ReportPayloadInput {
    event: ReportEvent;
    ev: Evaluation | undefined;
    settings: ReportSettings;
    state: ReportState;
    device: { hostname?: string; osUser?: string };
    extensionVersion: string;
    vscodeVersion: string;
    remoteName: string | undefined;
    enforcementMode: EnforceMode;
    /** 遮断の記録が有効(idle 以外)か。apply 直後の拡張ホスト再起動で enforcement イベントが落ちても状態が分かるように毎回入れる */
    enforcementActive: boolean;
    requireOrganization: string;
    extra?: Record<string, unknown>;
    /** 受信側の重複排除用。複数ウィンドウが同じ出来事を送っても同じ値になる */
    dedupeKey: string;
    now: number;
}

/**
 * 送信ペイロード(純粋関数)。ホワイトリスト方式で組み立て、Evaluation 以外の値(トークン等)は構造上含まれない。
 * 組織名は送らず、必須 Organization との一致だけを送る(無関係な所属の露出を避ける)。
 */
function buildReportPayload(i: ReportPayloadInput): Record<string, unknown> {
    const ev = i.ev;
    const device: Record<string, string> = {};
    if (i.settings.deviceFields.includes('hostname') && i.device.hostname) {
        device.hostname = i.device.hostname;
    }
    if (i.settings.deviceFields.includes('osUser') && i.device.osUser) {
        device.osUser = i.device.osUser;
    }
    if (i.settings.deviceFields.includes('installId')) {
        device.installId = i.state.installId;
    }
    return {
        schema: 1,
        event: i.event,
        // eventId は送信ごとに一意(複数ウィンドウが同じ出来事を送ると seq は衝突しうる)。重複排除には dedupeKey を使う
        eventId: randomUUID(),
        dedupeKey: i.dedupeKey,
        seq: i.state.seq,
        timestamp: new Date(i.now).toISOString(),
        status: ev?.status ?? 'unknown',
        account: ev?.account ?? '',
        plan: ev?.plan ?? '',
        tier: ev?.tier ?? 'unknown',
        sku: ev?.sku ?? '',
        source: ev?.source ?? 'public',
        apiEndpoint: ev?.apiEndpoint ?? '',
        violationCodes: ev?.codes ?? [],
        // 文言は組織名やエンドポイントなどの実データを含みうるため、コードから生成した定型文だけを送る
        violations: (ev?.codes ?? []).map(describeCode),
        requiredOrganization: i.requireOrganization || null,
        requiredOrgMatch: ev?.requiredOrgMatch ?? null,
        seatOrgsKnown: ev?.orgsAuthoritative ?? false,
        enforcementMode: i.enforcementMode,
        enforcementActive: i.enforcementActive,
        extension: { id: 'Kuro524.copilot-license-guard', version: i.extensionVersion },
        vscode: { version: i.vscodeVersion, remoteName: i.remoteName ?? null },
        device,
        ...(i.extra ?? {})
    };
}

function escapeSlack(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Slack Incoming Webhook 互換の 1 メッセージ。利用者由来の文字列はエスケープする(<!channel> 等の注入防止)。 */
function formatSlackText(p: Record<string, unknown>): string {
    const icon = p.status === 'violation' ? '⚠️' : p.status === 'ok' ? '✅' : '❔';
    const device = (p.device as Record<string, string> | undefined) ?? {};
    const who = [p.account, device.hostname ? `@${device.hostname}` : ''].filter(Boolean).join(' ');
    const head = `${icon} Copilot License Guard — ${p.event}: ${who} — ${p.status} (${p.plan || p.tier})`;
    const lines = (p.violations as string[] | undefined ?? []).map(v => `• ${v}`);
    const enf = p.enforcement as { action?: string; result?: string } | undefined;
    if (enf) {
        lines.push(`• enforcement: ${enf.action} (${enf.result})`);
    }
    return escapeSlack([head, ...lines].join('\n'));
}

/** 違反コードの定型説明(レポート用。実データを含めない) */
function describeCode(code: ViolationCode): string {
    switch (code) {
        case 'endpoint_unknown': return 'Copilot API エンドポイントからプラン種別を判定できません';
        case 'individual_tier': return '個人向け Copilot エンドポイントで動作しています(組織シート未適用)';
        case 'tier_not_allowed': return 'プラン種別が allowedPlans で許可されていません';
        case 'individual_plan': return '個人プラン(既知のプラン名)で動作しています';
        case 'plan_not_allowed': return 'プラン名が allowedPlans で許可されていません(未知の名前を含む)';
        case 'free_sku': return 'SKU が free_limited_copilot (Copilot Free 確定)';
        case 'free_quota': return 'Free のクォータ制限下にあります';
        case 'no_seat': return '組織の Copilot シートが割り当てられていません';
        case 'no_seat_org': return 'シート提供元の組織がありません';
        case 'required_org_seat_mismatch': return '必須 Organization 以外からシートが提供されています';
        case 'org_not_member': return '必須 Organization のメンバーではありません';
        case 'org_pending': return '必須 Organization への参加が未完了です';
        case 'account_mismatch': return 'VS Code のアカウントと API 応答のアカウントが一致しません';
        default: return String(code);
    }
}

interface ReportDecisionInput {
    status: Evaluation['status'] | 'disabled';
    key: string;
    state: ReportState;
    events: ReportEvent[];
    now: number;
}

/**
 * 送るべきイベントを決める(純粋関数)。基準は「最後に**送信に成功した**状態」。
 * - violation: 未解消の違反(openViolationKey)と内容が違うとき、または同じ内容でも前回の violation 送信から 24 時間
 * - recovered: 未解消の違反がある状態で ok になったとき(途中に unknown / disabled を挟んでも送る)
 * - unknown / monitoringDisabled: その状態への遷移時
 * - heartbeat: 期限到来時(次回時刻は送信成功後に進める。未設定なら初期化だけ行う)
 */
function decideReportEvents(i: ReportDecisionInput): { events: ReportEvent[]; initHeartbeat: boolean } {
    const out: ReportEvent[] = [];
    const want = (e: ReportEvent) => i.events.includes(e);

    if (i.status === 'violation') {
        const lastV = i.state.lastViolationSentAt ? Date.parse(i.state.lastViolationSentAt) : 0;
        if (want('violation') && (i.state.openViolationKey !== i.key || i.now - lastV >= REPORT_REPEAT_MS)) {
            out.push('violation');
        }
    } else if (i.status === 'ok') {
        if (want('recovered') && i.state.openViolationKey) {
            out.push('recovered');
        }
    } else if (i.status === 'unknown') {
        if (want('unknown') && i.state.lastSentStatus !== 'unknown') {
            out.push('unknown');
        }
    } else if (i.status === 'disabled') {
        if (want('monitoringDisabled') && i.state.lastSentStatus !== 'disabled') {
            out.push('monitoringDisabled');
        }
    }

    let initHeartbeat = false;
    if (want('heartbeat')) {
        if (!i.state.nextHeartbeatAt) {
            initHeartbeat = true;
        } else if (i.now >= Date.parse(i.state.nextHeartbeatAt) && !out.length) {
            out.push('heartbeat');
        }
    }
    return { events: out, initHeartbeat };
}

/**
 * 受信側の重複排除キー(純粋関数)。複数ウィンドウが同じ出来事を同時に送っても同じ値になるように、
 * 「何の出来事か」と「直前に送信成功した状態」から決める(連番や乱数、時刻の丸めは使わない)。
 * 同じ日に 違反→復帰→違反 と繰り返しても別の鍵になる(直前の送信時刻が変わるため)。
 * installId をそのまま含めず SHA-256 で畳むので、鍵から端末や他の出来事を結び付けられない。
 */
function reportDedupeKey(event: ReportEvent, key: string, state: ReportState, now: number): string {
    const id = state.installId;
    let raw: string;
    switch (event) {
        case 'violation':
        case 'unknown':
        case 'monitoringDisabled':
            raw = `${id}:${event}:${key}:${state.lastSentStatus ?? ''}:${state.lastSentAt ?? ''}`;
            break;
        case 'recovered':
            raw = `${id}:recovered:${state.openViolationKey ?? ''}:${state.lastViolationSentAt ?? ''}`;
            break;
        case 'heartbeat':
            raw = `${id}:heartbeat:${state.nextHeartbeatAt ?? ''}`;
            break;
        default:
            raw = `${id}:${event}:${now}`;
            break;
    }
    return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/** 次回ハートビート時刻。全端末が同時刻に送らないよう ±10% のジッターを入れる */
function nextHeartbeat(now: number, hours: number): string {
    return new Date(now + hours * 3_600_000 * (0.9 + Math.random() * 0.2)).toISOString();
}
function readReportState(): ReportState {
    const s = extContext.globalState.get<ReportState>(REPORT_KEY);
    if (s && s.installId) {
        return { ...s, seq: s.seq ?? 0 };
    }
    return { installId: randomUUID(), seq: 0 };
}

function reportKeyOf(ev: Evaluation | undefined): string {
    return ev ? `${ev.status}:${[...ev.codes].sort().join(',')}` : 'none';
}

function deviceInfo(): { hostname?: string; osUser?: string } {
    const out: { hostname?: string; osUser?: string } = {};
    try { out.hostname = os.hostname(); } catch { /* 取得できなければ送らない */ }
    try { out.osUser = os.userInfo().username; } catch { /* 同上 */ }
    return out;
}

/** 同一ウィンドウ内の送信を直列化する(連番の重複と状態の上書きを防ぐ) */
let reportQueue: Promise<unknown> = Promise.resolve();

/** 読み直した最新の ReportState に対して部分更新を適用して保存する(他の送信や別ウィンドウの更新を潰さない) */
async function patchReportState(patch: (s: ReportState) => void): Promise<ReportState> {
    const s = readReportState();
    patch(s);
    await extContext.globalState.update(REPORT_KEY, s);
    return s;
}

/**
 * 1 件送信する。GitHub 呼び出しとは独立したクライアントで、トークンには一切触れない。
 * リダイレクトは追わない(別ホストへヘッダーや本文が流れるのを防ぐ)。失敗は判定結果に影響させない。
 * `test` 以外は report.events で有効なイベントだけ送る。
 */
function sendReport(event: ReportEvent, ev: Evaluation | undefined, extra?: Record<string, unknown>, dedupeKey?: string): Promise<boolean> {
    const run = reportQueue.then(() => sendReportNow(event, ev, extra, dedupeKey), () => sendReportNow(event, ev, extra, dedupeKey));
    reportQueue = run.catch(() => undefined);
    return run;
}

async function sendReportNow(event: ReportEvent, ev: Evaluation | undefined, extra?: Record<string, unknown>, dedupeKey?: string): Promise<boolean> {
    const settings = readReportSettings();
    if (!settings.url) {
        return false;
    }
    if (event !== 'test' && !settings.events.includes(event)) {
        return false;
    }
    const v = validateReportUrl(settings.url);
    if (!v.ok) {
        log(`レポート送信: 送信先が不正なため送りません (${v.reason})`);
        return false;
    }
    const pre = readReportState();
    if (pre.backoffUntil && Date.parse(pre.backoffUntil) > Date.now()) {
        log(`レポート送信: 429 のため ${pre.backoffUntil} まで送信を控えています`);
        return false;
    }
    // 連番は最初の await の前に確定・保存する(同時送信で eventId が重複しないように)
    const state = await patchReportState(s => { s.seq = (s.seq ?? 0) + 1; });
    const payload = buildReportPayload({
        event, ev, settings, state, device: deviceInfo(),
        extensionVersion: extensionVersion, vscodeVersion: vscode.version, remoteName: vscode.env.remoteName,
        enforcementMode: enforceMode(),
        enforcementActive: readJournal().state !== 'idle',
        requireOrganization: (config().get<string>('requireOrganization', '') || '').trim(),
        extra, dedupeKey: dedupeKey ?? `${event}:${randomUUID()}`, now: Date.now()
    });
    const body = settings.format === 'slack' ? JSON.stringify({ text: formatSlackText(payload) }) : JSON.stringify(payload);

    const attempt = async (): Promise<Response> => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REPORT_TIMEOUT_MS);
        try {
            return await fetch(settings.url, {
                method: 'POST',
                headers: { ...settings.headers, 'Content-Type': 'application/json', 'User-Agent': userAgent },
                body,
                redirect: 'error',
                signal: ctrl.signal
            });
        } finally {
            clearTimeout(timer);
        }
    };

    let res: Response | undefined;
    let lastErr = '';
    for (let n = 0; n < 2 && !res; n++) {
        try {
            const r = await attempt();
            if (r.status >= 500 && n === 0) {
                lastErr = `HTTP ${r.status}`;
                await new Promise(resolve => setTimeout(resolve, 5_000));
                continue;
            }
            res = r;
        } catch (err) {
            lastErr = sanitizeError(err);
            if (n === 0) {
                await new Promise(resolve => setTimeout(resolve, 5_000));
            }
        }
    }

    if (!res) {
        log(`レポート送信: 失敗 (${event} -> ${v.host}): ${lastErr}`);
        return false;
    }
    if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after')) || 300;
        const until = new Date(Date.now() + Math.min(ra, 3600) * 1000).toISOString();
        await patchReportState(s => { s.backoffUntil = until; });
        log(`レポート送信: 429 (${v.host})。${until} まで控えます`);
        return false;
    }
    if (!res.ok) {
        log(`レポート送信: 失敗 (${event} -> ${v.host}): HTTP ${res.status}`);
        return false;
    }
    log(`レポート送信: ${event} -> ${v.host} (HTTP ${res.status}, seq=${state.seq})`);
    return true;
}

/** チェック結果に基づく自動送信(状態遷移 + ハートビート)。複数ウィンドウの重複はベストエフォートで抑える。 */
async function reportAfterCheck(ev: Evaluation | undefined, status: Evaluation['status'] | 'disabled'): Promise<void> {
    const settings = readReportSettings();
    if (!settings.url) {
        return;
    }
    const now = Date.now();
    const key = ev ? reportKeyOf(ev) : status;
    const decision = decideReportEvents({ status, key, state: readReportState(), events: settings.events, now });
    if (decision.initHeartbeat) {
        await patchReportState(s => { if (!s.nextHeartbeatAt) { s.nextHeartbeatAt = nextHeartbeat(now, settings.heartbeatHours); } });
    }
    for (const event of decision.events) {
        // 直前に別ウィンドウが同じ内容を送っていたら送らない
        const fresh = readReportState();
        if (event !== 'heartbeat' && fresh.lastSentKey === key && fresh.lastSentAt && now - Date.parse(fresh.lastSentAt) < 60_000) {
            continue;
        }
        const ok = await sendReport(event, ev, undefined, reportDedupeKey(event, key, fresh, now));
        if (!ok) {
            continue;
        }
        const sentAt = new Date().toISOString();
        await patchReportState(s => {
            s.lastSentStatus = status;
            s.lastSentKey = key;
            s.lastSentAt = sentAt;
            if (event === 'violation') {
                s.openViolationKey = key;
                s.lastViolationSentAt = sentAt;
            } else if (event === 'recovered') {
                delete s.openViolationKey;
                delete s.lastViolationSentAt;
            } else if (event === 'heartbeat') {
                s.nextHeartbeatAt = nextHeartbeat(Date.now(), settings.heartbeatHours);
            }
        });
    }
}
/** 送信が有効なら、その旨を利用者に一度だけ知らせる(透明性のため) */
async function showReportNoticeOnce(): Promise<void> {
    const settings = readReportSettings();
    if (!settings.url) {
        return;
    }
    const v = validateReportUrl(settings.url);
    if (!v.ok) {
        return;
    }
    const state = readReportState();
    if (state.noticeShownFor === v.host) {
        return;
    }
    await patchReportState(s => { s.noticeShownFor = v.host; });
    const pick = await vscode.window.showInformationMessage(
        `Copilot License Guard: 組織の設定により、この端末の Copilot ライセンス状態(アカウント名・プラン・違反理由${settings.deviceFields.length ? '・端末情報' : ''})が ${v.host} へ送信されます。`,
        '送信内容の詳細'
    );
    if (pick) {
        void vscode.env.openExternal(vscode.Uri.parse('https://github.com/Kuro524/copilot-license-guard/blob/main/PRIVACY.md'));
    }
}

async function testReportCommand(): Promise<void> {
    const settings = readReportSettings();
    if (!settings.url) {
        void vscode.window.showWarningMessage('Copilot License Guard: 設定 copilotLicenseGuard.report.url が未設定です。');
        return;
    }
    const v = validateReportUrl(settings.url);
    if (!v.ok) {
        void vscode.window.showErrorMessage(`Copilot License Guard: 送信先が不正です: ${v.reason}`);
        return;
    }
    const ok = await sendReport('test', lastEvaluation, { note: 'manual test' });
    if (ok) {
        void vscode.window.showInformationMessage(`Copilot License Guard: ${v.host} へテスト送信しました (format: ${settings.format})。`);
    } else {
        void vscode.window.showErrorMessage(`Copilot License Guard: ${v.host} へのテスト送信に失敗しました。出力パネルを確認してください。`);
        output.show(true);
    }
}

/** 直近の遮断/送信状態(ツールチップとモーダル表示用) */
let lastEnforce: EnforceOutcome | undefined;

function channelLabel(): string {
    return extensionVersion.includes('-nightly') ? ' (nightly)' : '';
}

/** ツールチップ末尾に付ける試験版機能の状態行 */
function extrasTooltip(): string {
    const lines: string[] = [];
    const rs = readReportSettings();
    if (rs.url) {
        const v = validateReportUrl(rs.url);
        lines.push(`- レポート送信先: ${v.ok ? `\`${v.host}\`` : '_(設定が不正)_'}`);
    }
    if (enforceMode() === 'disableAI') {
        const j = readJournal();
        const state = j.state === 'idle'
            ? (j.suspendedUntil && Date.parse(j.suspendedUntil) > Date.now() ? `手動停止中(〜${j.suspendedUntil})` : '待機中')
            : (lastEnforce?.overriddenBy ? `適用中 — **${lastEnforce.overriddenBy} 設定で上書きされています**` : '適用中(AI 機能を停止)');
        lines.push(`- 遮断(chat.disableAIFeatures): ${state}`);
    }
    return lines.length ? `\n${lines.join('\n')}\n` : '';
}

function updateStatusBar(ev: Evaluation | undefined, enforcedOverride?: boolean): void {
    if (!config().get<boolean>('statusBar', true)) {
        statusBar.hide();
        return;
    }

    const enforced = enforcedOverride ?? (readJournal().state !== 'idle');

    if (!ev || ev.status === 'unknown') {
        statusBar.text = enforced ? '$(circle-slash) Copilot: 不明 停止中' : '$(question) Copilot: 不明';
        statusBar.tooltip = new vscode.MarkdownString(
            `**Copilot License Guard${channelLabel()} — 判定不能**\n\n` +
            `${ev?.note ?? 'Copilot ライセンスを判定できません'}\n` +
            (enforced ? '\n_遮断は解除していません(問題なしを確認してから復帰します)_\n' : '') +
            extrasTooltip() + `\nクリックで再チェック`
        );
        statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (ev.status === 'ok') {
        statusBar.text = `$(shield) Copilot: ${ev.plan}`;
        statusBar.tooltip = new vscode.MarkdownString(
            `**Copilot License Guard${channelLabel()} — OK**\n\n` +
            `- アカウント: \`${ev.account}\`\n` +
            `- プラン: \`${ev.plan}\`\n` +
            (ev.sku ? `- SKU: \`${ev.sku}\`\n` : '') +
            `- Organization: ${ev.orgs.map(o => `\`${o}\``).join(', ') || 'なし'}` +
            `${ev.orgs.length && !ev.orgsAuthoritative ? ' _(所属組織。シート提供元ではありません)_' : ''}\n` +
            `- API: \`${ev.apiEndpoint}\`\n` +
            `- 判定元: ${ev.source === 'public' ? '公開 API のみ' : '公開 API + 非公式 API'}\n` +
            extrasTooltip() +
            (ev.infos.length ? `\n${ev.infos.map(i => `_${i}_`).join('\n\n')}\n` : '')
        );
        statusBar.backgroundColor = undefined;
    } else {
        statusBar.text = enforced
            ? `$(circle-slash) Copilot: ${ev.plan.toUpperCase()} 停止中`
            : `$(alert) Copilot: ${ev.plan.toUpperCase()} 要確認`;
        statusBar.tooltip = new vscode.MarkdownString(
            `**⚠ Copilot ライセンス違反${channelLabel()}**\n\n` +
            ev.violations.map(v => `- ${v}`).join('\n') +
            (enforced ? '\n\n**組織の設定により Copilot の AI 機能を一時停止しています。違反が解消されると自動で復帰します。**\n' : '') +
            extrasTooltip() +
            `\n\nクリックで再チェック`
        );
        statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    statusBar.show();
}

async function showViolationWarning(ev: Evaluation, enforcedOverride?: boolean): Promise<void> {
    if (warningOpen) {
        return;
    }
    warningOpen = true;
    try {
        const enforced = enforcedOverride ?? (readJournal().state !== 'idle');
        const detail = [
            ...(enforced ? [
                '⛔ 組織の設定により、Copilot の AI 機能(チャット・補完)を一時停止しました。',
                '   違反が解消されると自動で復帰します。',
                ''
            ] : []),
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
            enforced
                ? '⛔ GitHub Copilot のライセンス違反を検出したため AI 機能を一時停止しました'
                : '⚠ GitHub Copilot が意図したライセンスで動作していません',
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
/**
 * 警告画面のプレビュー(デモデータ)。組織の管理者が「利用者に何が表示されるか」を、
 * 実際に違反を起こさずに確認するためのコマンド。実データ(アカウント名・組織名)は使わない。
 */
async function previewUiCommand(itemId?: string): Promise<void> {
    const demo: Evaluation = {
        status: 'violation',
        plan: 'free', tier: 'individual', sku: 'free_limited_copilot',
        account: 'octocat', orgs: [], orgsAuthoritative: true,
        apiEndpoint: 'https://api.individual.githubcopilot.com', source: 'public+internal',
        violations: [
            '個人向け Copilot で動作しています (https://api.individual.githubcopilot.com)。組織シートが適用されていません。',
            `SKU が 'free_limited_copilot' = Copilot Free 確定です。`,
            'can_signup_for_limited=true = 組織の Copilot シートが割り当てられていません。'
        ],
        codes: ['individual_tier', 'free_sku', 'no_seat'],
        infos: [],
        requiredOrgMatch: null
    };
    const okDemo: Evaluation = {
        ...demo, status: 'ok', plan: 'business', tier: 'business', sku: 'copilot_for_business_seat',
        orgs: ['contoso'], apiEndpoint: 'https://api.business.githubcopilot.com', violations: [], codes: []
    };
    const items = [
        { label: '$(alert) 違反モーダル(警告のみ)', id: 'modal' },
        { label: '$(circle-slash) 違反モーダル(遮断あり)', id: 'modal-enforced' },
        { label: '$(layout-statusbar) ステータスバー: 要確認 → 停止中 → 不明 → 正常 (各 10 秒)', id: 'statusbar' },
        { label: '$(info) レポート送信が有効なときの通知', id: 'notice' },
        { label: '$(warning) 復帰後に無効のまま残った拡張の通知', id: 'left-disabled' },
        { label: '$(pass) 手動チェックが正常だったときの通知', id: 'ok' }
    ];
    // itemId 指定時(開発者向けフック CLG_PREVIEW)は選択 UI を出さない。'statusbar:<warn|enforced|unknown|ok>' は 1 状態を保持する
    const pick = itemId
        ? { id: itemId }
        : await vscode.window.showQuickPick(items, { placeHolder: 'Copilot License Guard: プレビューする画面を選択(デモデータ。実際の判定や設定は変更しません)' });
    if (!pick) {
        return;
    }
    log(`プレビュー表示: ${pick.id}`);
    if (pick.id.startsWith('statusbar:')) {
        const which = pick.id.slice('statusbar:'.length);
        const map: Record<string, [Evaluation | undefined, boolean]> = { warn: [demo, false], enforced: [demo, true], unknown: [undefined, false], ok: [okDemo, false] };
        const sel = map[which];
        if (sel) {
            updateStatusBar(sel[0], sel[1]);
            // デモ表示が本物の状態(赤/停止中)を長く隠さないよう 60 秒で戻す
            setTimeout(() => updateStatusBar(lastEvaluation), 60_000);
        }
        return;
    }
    switch (pick.id) {
        case 'modal':
            await showViolationWarning(demo, false);
            break;
        case 'modal-enforced':
            await showViolationWarning(demo, true);
            break;
        case 'statusbar': {
            const steps: [Evaluation | undefined, boolean][] = [[demo, false], [demo, true], [undefined, false], [okDemo, false]];
            for (const [ev, enforced] of steps) {
                updateStatusBar(ev, enforced);
                await new Promise(resolve => setTimeout(resolve, 10_000));
            }
            updateStatusBar(lastEvaluation);
            break;
        }
        case 'notice':
            void vscode.window.showInformationMessage(
                'Copilot License Guard: 組織の設定により、この端末の Copilot ライセンス状態(アカウント名・プラン・違反理由・端末情報)が hooks.example.com へ送信されます。',
                '送信内容の詳細'
            );
            break;
        case 'left-disabled':
            void vscode.window.showWarningMessage(
                'Copilot License Guard: 遮断の解除後、2 件の拡張機能が無効のままです(ms-dotnettools.vscode-dotnet-modernize, vscjava.migrate-java-to-azure)。' +
                'VS Code が Copilot Chat と一緒に無効化したもので、必要なら拡張機能ビューから有効化してください。',
                '無効な拡張機能を表示'
            );
            break;
        case 'ok':
            void vscode.window.showInformationMessage('✅ Copilot は business ライセンスで動作しています (octocat / contoso)');
            break;
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
        // 監視を止めても遮断を取り残さない。送信が有効なら「監視停止」を 1 回だけ報告する
        try {
            lastEnforce = await enforce(lastEvaluation ?? unknownEvaluation('(無効)', '監視が無効化されています'), false);
            await flushPendingEnforcementReport(lastEvaluation);
        } catch (err) {
            log(`遮断の解除に失敗しました: ${sanitizeError(err)}`);
        }
        void reportAfterCheck(undefined, 'disabled');
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
                ev.codes.push('account_mismatch');
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

    // 試験版機能: 遮断 → レポート → UI の順。UI(モーダル)は待たない(閉じられるまで遮断や送信が止まらないように)。
    let enforceOutcome: EnforceOutcome | undefined;
    try {
        enforceOutcome = await enforce(ev, true);
        if (enforceOutcome.result !== 'skipped') {
            log(`遮断: ${enforceOutcome.action} -> ${enforceOutcome.result} (${enforceOutcome.reason})`);
        }
        if (enforceOutcome.overriddenBy && enforceOutcome.overriddenBy !== (lastEnforce?.overriddenBy ?? null)) {
            log(`遮断: 適用中ですが ${enforceOutcome.overriddenBy} の設定で上書きされています(実効値が true ではありません)`);
            void sendReport('enforcement', ev, { enforcement: { action: 'none', reason: 'overridden', active: true, overriddenBy: enforceOutcome.overriddenBy } },
                `enforcement:overridden:${enforceOutcome.overriddenBy}:${readJournal().appliedAt ?? ''}`);
        }
        lastEnforce = enforceOutcome;
        // 設定変更の前に記録したイベントを送る(拡張ホストが再起動していれば、ここで初めて送られる)
        await flushPendingEnforcementReport(ev);
        // 復帰後に無効のまま残った依存拡張があれば知らせる(再起動が無かった場合の経路)
        await notifyExtensionsLeftDisabled();
    } catch (err) {
        log(`遮断の処理でエラー: ${sanitizeError(err)}`);
    }
    void reportAfterCheck(ev, ev.status);

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
        log(`VIOLATION  account=${ev.account} plan=${ev.plan} sku=${ev.sku || '-'} codes=[${ev.codes.join(',')}] source=${ev.source}`);
        ev.violations.forEach(v => log(`  - ${v}`));
        ev.infos.forEach(i => log(`  (補足) ${i}`));
        void showViolationWarning(ev);
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
    const version = (context.extension.packageJSON as { version?: string } | undefined)?.version ?? 'unknown';
    userAgent = `CopilotLicenseGuard/${version}`;
    extensionVersion = version;
    output = vscode.window.createOutputChannel('Copilot License Guard');
    context.subscriptions.push(output);

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'copilotLicenseGuard.check';
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        vscode.commands.registerCommand('copilotLicenseGuard.check', () => runCheck(true)),
        vscode.commands.registerCommand('copilotLicenseGuard.showLog', () => output.show(true)),
        vscode.commands.registerCommand('copilotLicenseGuard.testReport', () => testReportCommand()),
        vscode.commands.registerCommand('copilotLicenseGuard.suspendEnforcement', () => suspendEnforcementCommand()),
        vscode.commands.registerCommand('copilotLicenseGuard.previewUi', () => previewUiCommand())
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
                if (e.affectsConfiguration('copilotLicenseGuard.report')) {
                    void showReportNoticeOnce();
                }
            }
        })
    );

    log('Copilot License Guard を起動しました。');
    log(`バージョン: ${version} / VS Code ${vscode.version}${version.includes('-nightly') ? '  ※試験版 (nightly) ビルドです' : ''}`);
    log('プラン種別の判定には GitHub の公開 GraphQL API (viewer.copilotEndpoints) を使用します。');
    if (config().get<boolean>('useInternalApi', true)) {
        log('注意: 詳細情報(プラン名/SKU/シート提供元)の取得に、GitHub 公式にサポートされていない ' +
            'エンドポイント /copilot_internal/user を併用します。' +
            '不要な場合は設定 copilotLicenseGuard.useInternalApi を false にしてください。');
    } else {
        log('詳細情報の取得(非公式 API)は無効です。公開 API のみで判定します。');
    }
    // 試験版機能の状態
    {
        const rs = readReportSettings();
        if (rs.url) {
            const v = validateReportUrl(rs.url);
            log(v.ok
                ? `レポート送信: 有効 (${v.host}, format=${rs.format}, events=[${rs.events.join(',')}], device=[${rs.deviceFields.join(',')}])`
                : `レポート送信: 設定が不正なため無効 (${v.reason})`);
        }
        if (enforceMode() === 'disableAI') {
            const j = readJournal();
            log(`遮断: 有効 (違反時に ${AI_DISABLE_SETTING} を true にします。現在の記録: ${j.state}` +
                `${j.suspendedUntil ? `, 手動停止 〜${j.suspendedUntil}` : ''})`);
            if (j.state === 'applying' || j.state === 'releasing') {
                log(`遮断: 前回の処理が '${j.state}' で中断していました。次回チェックで整合させます。`);
            }
            if (j.restoredAt && j.extensionsBefore) {
                // 復帰 → VS Code の再有効化 → 拡張ホスト再起動、の後にここへ来る。少し待ってから残った無効拡張を確認する
                setTimeout(() => { void notifyExtensionsLeftDisabled(); }, 25_000);
            }
            const [maj, min] = vscode.version.split('.').map(n => parseInt(n, 10));
            if (maj < 1 || (maj === 1 && min < 104)) {
                log(`注意: ${AI_DISABLE_SETTING} は VS Code 1.104 以降の設定です。この VS Code (${vscode.version}) では遮断は機能しません。`);
            }
        }
        void showReportNoticeOnce();
    }
    // 開発者向け: 環境変数 CLG_PREVIEW=<modal|modal-enforced|statusbar:warn|...> を付けて VS Code を起動すると、
    // 起動後にその画面をデモデータで表示する(ドキュメント用スクリーンショットの撮影に使う。通常の利用では未設定)。
    // リモート(WSL/SSH/コンテナー)では環境変数をリポジトリ側(remoteEnv 等)から注入できるため、ローカルのデスクトップ窓でのみ有効にする。
    const previewItem = process.env.CLG_PREVIEW;
    if (previewItem && vscode.env.remoteName === undefined && vscode.env.uiKind === vscode.UIKind.Desktop) {
        log(`開発者向けプレビュー: ${previewItem} を 6 秒後に表示します (CLG_PREVIEW)`);
        setTimeout(() => { void previewUiCommand(previewItem); }, 6_000);
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

/** テスト専用: 純粋関数を公開する(VS Code は余分な export を無視する)。副作用のある関数は含めない。 */
export const __internals = {
    tierFromApiEndpoint,
    tierOfPlan,
    tierLabel,
    skuToPlan,
    evaluate,
    internalFreeSignals,
    hasStrongViolation,
    planEnforcement,
    validateReportUrl,
    buildReportPayload,
    formatSlackText,
    decideReportEvents,
    reportDedupeKey
};
