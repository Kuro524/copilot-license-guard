import * as vscode from 'vscode';

/** GitHub 内部 API /copilot_internal/user のレスポンス(必要部分のみ) */
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
    sku: string;
    account: string;
    orgs: string[];
    apiEndpoint: string;
    violations: string[];
    note?: string;
}

const COPILOT_USER_API = 'https://api.github.com/copilot_internal/user';

/** Copilot が使う GitHub セッションを探すためのスコープ候補(広い順に試す) */
const SCOPE_CANDIDATES: string[][] = [
    ['read:user'],
    ['user:email'],
    []
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

function log(message: string): void {
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
        const session = await vscode.authentication.getSession('github', ['read:user'], { createIfNone: true });
        if (session) {
            log(`アクセス許可を取得しました: ${session.account.label}`);
        }
        return session;
    } catch (err) {
        log(`アクセス許可の取得に失敗しました: ${String(err)}`);
        return undefined;
    }
}

async function fetchCopilotUser(token: string): Promise<CopilotUserInfo> {
    const res = await fetch(COPILOT_USER_API, {
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/json',
            'Editor-Version': `vscode/${vscode.version}`,
            'Editor-Plugin-Version': 'copilot-license-guard/1.0.0',
            'User-Agent': 'CopilotLicenseGuard/1.0.0'
        }
    });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as CopilotUserInfo;
}

/** 取得済み情報を設定と突き合わせて違反を列挙する */
function evaluate(info: CopilotUserInfo, account: string): Evaluation {
    const cfg = config();
    const allowed = cfg.get<string[]>('allowedPlans', ['business', 'enterprise']);
    const requireOrg = (cfg.get<string>('requireOrganization', '') || '').trim();
    const warnOrgless = cfg.get<boolean>('warnOnOrganizationless', true);

    const sku = info.access_type_sku ?? '';
    const plan = (info.copilot_plan ?? '').toLowerCase() || skuToPlan(sku);
    const orgs = info.organization_login_list ?? [];
    const apiEndpoint = info.endpoints?.api ?? '';

    const violations: string[] = [];

    if (!allowed.includes(plan)) {
        violations.push(`使用中のプランが許可外です: ${plan || '(不明)'}${sku ? ` (sku: ${sku})` : ''}`);
    }
    // Free 確定シグナル (microsoft/vscode の isFreeUser 相当)
    if (sku === 'free_limited_copilot') {
        violations.push(`SKU が 'free_limited_copilot' = Copilot Free 確定です。`);
    }
    if (info.limited_user_quotas !== undefined && info.limited_user_quotas !== null) {
        violations.push('limited_user_quotas が設定されています = Free のクォータ制限下にあります。');
    }
    if (info.can_signup_for_limited === true) {
        violations.push('can_signup_for_limited=true = 組織の Copilot シートが割り当てられていません。');
    }
    if (warnOrgless && orgs.length === 0) {
        violations.push('organization_login_list が空です = 組織経由の Copilot を使用していません。');
    }
    if (apiEndpoint && !/business\.githubcopilot\.com|enterprise/.test(apiEndpoint)) {
        violations.push(`API エンドポイントが法人用ではありません: ${apiEndpoint}`);
    }
    if (requireOrg && !orgs.includes(requireOrg)) {
        violations.push(`必須 Organization '${requireOrg}' にシートが紐づいていません (現在: ${orgs.join(', ') || 'なし'})`);
    }

    return {
        status: violations.length > 0 ? 'violation' : 'ok',
        plan, sku, account, orgs, apiEndpoint, violations
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
            `- SKU: \`${ev.sku}\`\n` +
            `- Organization: ${ev.orgs.map(o => `\`${o}\``).join(', ') || 'なし'}\n` +
            `- API: \`${ev.apiEndpoint}\`\n\n` +
            `_判定には GitHub の非公式 API を使用しています。最終確認は組織の管理画面で行ってください。_`
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
            `SKU        : ${ev.sku || '(不明)'}`,
            `Organization : ${ev.orgs.join(', ') || 'なし'}`,
            `API        : ${ev.apiEndpoint || '(不明)'}`,
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
            ev = {
                status: 'unknown', plan: 'unknown', sku: '', account: '(未サインイン)',
                orgs: [], apiEndpoint: '', violations: [],
                note: 'GitHub アカウントへのアクセスが許可されていません。ステータスバーの項目をクリックして許可してください。'
            };
            log('GitHub セッションを取得できませんでした。');
        } else {
            const info = await fetchCopilotUser(session.accessToken);
            ev = evaluate(info, info.login ?? session.account.label);

            // VS Code のサインインアカウントと API 応答のアカウントが食い違う場合も事故
            if (info.login && session.account.label &&
                info.login.toLowerCase() !== session.account.label.toLowerCase()) {
                ev.violations.push(
                    `アカウント不一致: VS Code='${session.account.label}' / API='${info.login}'`
                );
                ev.status = 'violation';
            }
        }
    } catch (err) {
        ev = {
            status: 'unknown', plan: 'unknown', sku: '', account: '(取得失敗)',
            orgs: [], apiEndpoint: '', violations: [],
            note: `ライセンス情報を取得できませんでした: ${String(err)}`
        };
        log(`エラー: ${String(err)}`);
    } finally {
        // UI 表示前に解放する(モーダル表示中の再チェック要求をブロックしないため)
        checkRunning = false;
    }

    lastEvaluation = ev;
    updateStatusBar(ev);

    if (ev.status === 'ok') {
        log(`OK  account=${ev.account} plan=${ev.plan} sku=${ev.sku} orgs=[${ev.orgs.join(',')}]`);
        if (interactive) {
            void vscode.window.showInformationMessage(
                `✅ Copilot は ${ev.plan} ライセンスで動作しています (${ev.account} / ${ev.orgs.join(', ') || '組織なし'})`
            );
        }
    } else if (ev.status === 'violation') {
        log(`VIOLATION  account=${ev.account} plan=${ev.plan} sku=${ev.sku}`);
        ev.violations.forEach(v => log(`  - ${v}`));
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
    log('注意: プラン判定には GitHub の非公式エンドポイント /copilot_internal/user を使用しています。' +
        'これは GitHub 公式にサポートされておらず、予告なく変更・廃止される可能性があります。');
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
