'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

async function privateJson(directory, name, value) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) {
    throw new Error('Configuration owner mismatch');
  }
  await fs.chmod(directory, 0o700);
  const destination = path.join(directory, name);
  const temporary = destination + '.' + crypto.randomUUID();
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

function activate(context) {
  const initialize = async () => {
    try {
      if (process.platform !== 'linux' || vscode.env.remoteName !== 'ssh-remote') {
        throw new Error('Open a TRAE Remote SSH IDE window before initializing.');
      }
      // Use TRAE's command API rather than decrypting desktop credential storage.
      const [user, dynamicConfig, device] = await Promise.all([
        vscode.commands.executeCommand('icube.common.getUserInfo'),
        vscode.commands.executeCommand('icube.common.getDynamicConfig'),
        vscode.commands.executeCommand('icube.common.commands.tooling.getDeviceId'),
      ]);
      const account = user?.account;
      if (!user?.token || !user.userId || !account?.username || account.scope !== 'bytedance') {
        throw new Error('A signed-in internal TRAE account is required.');
      }
      const claims = JSON.parse(Buffer.from(user.token.split('.')[1], 'base64url').toString());
      if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) {
        throw new Error('TRAE returned an expired credential. Refresh its login first.');
      }
      if (device?.code !== 0 || !device.data?.deviceId) {
        throw new Error('Native TRAE initialization failed; no credentials were logged.');
      }
      const folders = (vscode.workspace.workspaceFolders || []).map(x => x.uri.fsPath);
      try {
        const file = path.join(os.homedir(), '.botmux', 'trae-native', 'workspaces.json');
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Configuration owner mismatch');
        const additional = JSON.parse(await fs.readFile(file, 'utf8')).folders;
        for (const folder of additional || []) {
          if (!path.isAbsolute(folder) || !(await fs.stat(folder)).isDirectory()) throw new Error('Configuration owner mismatch');
          if (!folders.includes(folder)) folders.push(folder);
        }
      } catch (error) {if (error.code !== 'ENOENT') throw error;}
      const tooling = name => 'icube.common.commands.tooling.' + name;
      const configuration = {};
      for (const key of ['AI.skills.enableAgentsDir', 'AI.skills.enablePeerProductSkills']) {
        configuration[key] = await vscode.commands.executeCommand(tooling('getConfigurationValue'), {key});
      }
      const rules = {};
      for (const folder of folders) {
        rules[folder] = {};
        for (const scope of ['user', 'project']) {
          rules[folder][scope] = await vscode.commands.executeCommand(tooling('getRulesDetails'), {
            scope, targetFolderPath: folder, workspaceFolders: [folder],
          });
        }
      }
      const directory = path.join(os.homedir(), '.botmux', 'trae-native');
      await privateJson(directory, 'auth.json', {
        version: 1,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
        userInfo: {
          name: account.username, token: user.token, user_id: user.userId,
          scope: account.scope, loginScope: account.loginScope, is_internal: true,
          ...(account.tenant_id ? {tenant_id: account.tenant_id} : {}),
        },
      });
      await privateJson(directory, 'runtime.json', {
        version: 1, deviceId: device.data.deviceId,
        dynamicConfig: dynamicConfig || {}, configuration, rules,
        workspaceFolders: folders, initializedAt: new Date().toISOString(),
      });
      await vscode.window.showInformationMessage(
        'Native TRAE login initialized on the development host. Runtime verification is still required.',
      );
    } catch (error) {
      // API exceptions may contain request headers; never print their raw text.
      const allowed = [
        'Open a TRAE Remote SSH IDE window before initializing.',
        'A signed-in internal TRAE account is required.',
        'TRAE returned an expired credential. Refresh its login first.',
        'Configuration owner mismatch',
      ];
      await vscode.window.showErrorMessage(allowed.includes(error.message)
        ? error.message : 'Native TRAE initialization failed; no credentials were logged.');
    }
  };
  context.subscriptions.push(vscode.commands.registerCommand('botmux.traeNative.initialize', initialize));
}
module.exports = {activate, deactivate() {}};
