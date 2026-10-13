'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {TextDecoder} = require('node:util');

const limit = 1536 * 1024;
function validateDirectory(folder) {
  if (!path.isAbsolute(folder || '') || !fs.statSync(folder).isDirectory()) {
    throw new Error('Native workspace must be an existing absolute directory');
  }
  return path.resolve(folder);
}
function within(file, root) {return file === root || file.startsWith(root + path.sep);}
function optionalStat(file) {
  try {return fs.statSync(file);} catch (error) {if (error.code === 'ENOENT') return undefined;throw error;}
}
function markdownFiles(folder, depth = 0) {
  if (!optionalStat(folder)?.isDirectory()) return [];
  const files = [];
  for (const item of fs.readdirSync(folder, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    const file = path.join(folder,item.name);
    if (item.isDirectory() && depth < 3) files.push(...markdownFiles(file,depth+1));
    else if (!item.isDirectory() && item.name.endsWith('.md') && optionalStat(file)?.isFile()) files.push(file);
    if (files.length > 5000) throw new Error('Native workspace has too many rule files');
  }
  return files;
}
function readRule(file, root, workspace, source) {
  const stat = fs.statSync(file);
  if (stat.size > limit) throw new Error('Native rule file exceeds 1.5 MiB');
  const bytes = fs.readFileSync(file);
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le'
    : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
  const raw = new TextDecoder(encoding,{fatal:true}).decode(bytes);
  const front = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  const metadata = {};
  // TRAE 3.4.2 uses these simple frontmatter fields rather than full YAML.
  if (source !== 'agents' && source !== 'claude' && front) {
    for (const line of front[1].split('\n')) {
      const colon = line.indexOf(':');
      if (colon < 0 || line.trim().startsWith('#')) continue;
      const key = line.slice(0,colon).trim(), value = line.slice(colon+1).trim();
      if (key === 'alwaysApply') metadata[key] = value.toLowerCase() === 'true';
      else if (key === 'globs' || key === 'scene') metadata[key] = value.split(',').map(x=>x.trim()).filter(Boolean);
      else if (key === 'description') metadata[key] = value;
    }
  }
  const fields = Object.keys(metadata).length ? metadata : null;
  const mode = fields?.alwaysApply === true ? 'alwaysApply'
    : fields && Object.hasOwn(fields,'globs') ? 'applyToSpecificFiles'
    : fields && Object.hasOwn(fields,'description') ? 'modelDecision'
    : fields?.alwaysApply === false ? 'manual' : 'alwaysApply';
  return {filePath:file,content:front ? raw.slice(front[0].length).trim() : raw,
    metadata:fields,mode,createdTime:stat.ctimeMs,modifiedTime:stat.mtimeMs,
    ...(workspace ? {workspaceFolder:workspace} : {}),ruleScopeRoot:root,
    ...(source ? {ruleSource:source} : {})};
}
class NativeWorkspace {
  constructor(cwd, nativeRoot) {
    this.cwd = validateDirectory(cwd);
    this.realCwd = fs.realpathSync(this.cwd);
    this.nativeRoot = nativeRoot;
    const product = JSON.parse(fs.readFileSync(path.join(nativeRoot,'product.json'),'utf8'));
    if (!/^\.[a-zA-Z0-9_-]+$/.test(product.dataFolderName || '')) throw new Error('Unknown native user-rule directory');
    this.userRoot = path.join(os.homedir(),product.dataFolderName);
  }
  resolve(file) {
    const absolute = path.resolve(file);
    if (within(absolute,this.cwd)) return absolute;
    if (within(absolute,this.realCwd)) return this.cwd + absolute.slice(this.realCwd.length);
    throw new Error('Native callback path is outside this session workspace');
  }
  matchesFolder(folder) {try {return this.resolve(folder) === this.cwd;} catch {return false;}}
  rules(args, runtime) {
    if (args.scope !== 'user' && args.scope !== 'project') throw new Error('Unknown native rule scope');
    const rules = new Map();
    const add = (file,root,source,workspace) => {
      if (optionalStat(file)?.isFile()) rules.set(file,readRule(file,root,workspace,source));
    };
    if (args.scope === 'user') {
      add(path.join(this.userRoot,'user_rules.md'),this.userRoot);
      for (const file of markdownFiles(path.join(this.userRoot,'user_rules'))) add(file,this.userRoot);
    } else {
      // A session owns its selected directory. Never inherit another project's
      // cached rule snapshot, or accept arbitrary callback workspace roots.
      if (args.workspaceFolders?.some(folder=>!this.matchesFolder(folder))
          || (args.targetFolderPath && !this.matchesFolder(args.targetFolderPath))) {
        throw new Error('Native rule request names a different workspace');
      }
      const targets = (args.targetFilePaths?.length ? args.targetFilePaths
        : args.targetFilePath ? [args.targetFilePath] : []).map(file=>this.resolve(file));
      const roots = new Set([this.cwd]);
      for (const file of targets) {
        for (let parent=path.dirname(file);within(parent,this.cwd);parent=path.dirname(parent)) {
          roots.add(parent);
          if (parent === this.cwd) break;
        }
      }
      const enabled = (key,fallback) => {
        const value=runtime.configuration?.[key];
        return (value && typeof value === 'object' && value.code === 0 ? value.data : value) ?? fallback;
      };
      for (const root of roots) {
        for (const file of markdownFiles(path.join(root,'.trae','rules'))) add(file,root,'trae',this.cwd);
        if (enabled('AI.rules.importAgentsMd',true)) add(path.join(root,'AGENTS.md'),root,'agents',this.cwd);
        if (enabled('AI.rules.importClaudeMd',false)) {
          for (const name of ['CLAUDE.local.md','CLAUDE.md','.claude/CLAUDE.md']) add(path.join(root,name),root,'claude',this.cwd);
        }
      }
      if (args.filePaths?.length) {
        const allowed = new Set(args.filePaths.map(file=>this.resolve(file)));
        for (const file of rules.keys()) if (!allowed.has(file)) rules.delete(file);
      }
      if (targets.length) {
        const picomatch = require(path.join(this.nativeRoot,'node_modules/picomatch'));
        for (const [file,rule] of rules) {
          const applicable = targets.some(target => {
            if (!within(target,rule.ruleScopeRoot) || rule.mode === 'manual') return false;
            if (rule.mode === 'modelDecision') return Boolean(rule.metadata?.description?.trim());
            if (rule.mode !== 'applyToSpecificFiles') return true;
            return (rule.metadata?.globs || []).some(glob => {
              const pattern = glob.startsWith('/') || glob.startsWith('**/') ? glob : '**/' + glob;
              const match = picomatch(pattern,{dot:true});
              return match(path.relative(this.cwd,target)) || match(path.relative(rule.ruleScopeRoot,target));
            });
          });
          if (!applicable) rules.delete(file);
        }
      }
    }
    let size = 0; const selected = [];
    for (const rule of rules.values()) {
      size += rule.content.length + rule.filePath.length + 200;
      if (size > limit) return {code:0,data:{rules:selected,isComplete:false}};
      selected.push(rule);
    }
    return {code:0,data:{rules:selected,isComplete:true}};
  }
}
module.exports = {NativeWorkspace,validateDirectory};
