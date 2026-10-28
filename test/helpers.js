// out/extension.js を、vscode モジュールをスタブして読み込むテスト用ヘルパー。
// 拡張本体が export する __internals(純粋関数)だけを使う。
const Module = require('module');
const path = require('path');

function loadExtension() {
    const state = { settings: {} };
    const vscodeStub = {
        workspace: {
            getConfiguration: () => ({
                get: (k, d) => (k in state.settings ? state.settings[k] : d)
            })
        },
        StatusBarAlignment: { Right: 2 },
        ThemeColor: class { constructor(id) { this.id = id; } },
        MarkdownString: class { constructor(v) { this.value = v; } },
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        version: '1.143.1',
        env: { machineId: 'test-machine', remoteName: undefined, uiKind: 1 },
        UIKind: { Desktop: 1, Web: 2 }
    };
    const origLoad = Module._load;
    Module._load = function (request, ...rest) {
        if (request === 'vscode') { return vscodeStub; }
        return origLoad.call(this, request, ...rest);
    };
    try {
        const extPath = path.join(__dirname, '..', 'out', 'extension.js');
        delete require.cache[require.resolve(extPath)];
        const ext = require(extPath);
        if (!ext.__internals) { throw new Error('out/extension.js が __internals を export していません(npm run compile 済みか確認)'); }
        return { T: ext.__internals, state, vscodeStub };
    } finally {
        Module._load = origLoad;
    }
}

module.exports = { loadExtension };