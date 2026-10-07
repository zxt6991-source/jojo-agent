import {
  CreateSkillInputSchema,
  GetExtensionStatusInputSchema,
  ImportSkillInputSchema, IPC,
  SaveExtensionSettingsInputSchema,
  SkillPathInputSchema,
  UpdateSkillInputSchema,
  type ExtensionStatus,
  type ProviderSettings
} from '@desktop-agent/contracts';
import { createSkillSource, discoverSkills, parseSkillSource, skillId, type SkillDirectory } from '@desktop-agent/extensions';
import { JsonConfigStore } from '@desktop-agent/storage';
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface Context {
  assertTrusted: (event: IpcMainInvokeEvent) => void;
  readApiKeys: () => Promise<Record<string, string>>;
  configStore: JsonConfigStore;
  skillDirectories: (settings: ProviderSettings, workingDirectory?: string) => SkillDirectory[];
  visibleSkillPaths: Map<string, ExtensionStatus['skills'][number]>;
  extensionStatus: ExtensionStatus;
  visibleSkill: (filePath: string) => ExtensionStatus['skills'][number];
  pathExists: (filePath: string) => Promise<boolean>;
  refreshManagedSkills: () => Promise<void>;
  mainWindow: BrowserWindow | null;
  replaceSkillDirectory: (sourceRoot: string, destinationRoot: string) => Promise<void>;
  pushConfig: () => Promise<void>;
}

export function registerExtensionsIpc(ctx: Context): void {
  ipcMain.handle(IPC.getExtensionStatus, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = GetExtensionStatusInputSchema.parse(raw ?? {});
    const apiKeys = await ctx.readApiKeys();
    const settings = await ctx.configStore.get(apiKeys);
    const skills = (await discoverSkills(ctx.skillDirectories(settings, input.workingDirectory), settings.extensions.skills.disabled))
      .map(({ content: _content, ...status }) => status);
    ctx.visibleSkillPaths = new Map(skills.map((skill) => [path.resolve(skill.path), skill]));
    return { ...ctx.extensionStatus, skills };
  });
  ipcMain.handle(IPC.getSkillDetail, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = SkillPathInputSchema.parse(raw);
    const skill = ctx.visibleSkill(input.path);
    const content = (await readFile(skill.path, 'utf8')).slice(0, 120_000);
    return { ...skill, content };
  });
  ipcMain.handle(IPC.createSkill, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = CreateSkillInputSchema.parse(raw);
    const root = path.join(app.getPath('userData'), 'skills', skillId(input.name));
    if (await ctx.pathExists(root)) throw new Error('同名用户 Skill 已存在，请打开后编辑或更新。');
    await mkdir(root, { recursive: true });
    await Promise.all(['scripts', 'templates', 'references'].map((name) => mkdir(path.join(root, name))));
    await writeFile(path.join(root, 'SKILL.md'), createSkillSource(input.name, input.description, input.instructions), { encoding: 'utf8', flag: 'wx' });
    await ctx.refreshManagedSkills();
    return { canceled: false, path: path.join(root, 'SKILL.md') };
  });
  ipcMain.handle(IPC.updateSkill, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = UpdateSkillInputSchema.parse(raw);
    const skill = ctx.visibleSkill(input.path);
    parseSkillSource(skill.path, input.content);
    let destinationFile = skill.path;
    if (skill.origin === 'default') {
      const destinationRoot = path.join(app.getPath('userData'), 'skills', skill.id);
      if (!(await ctx.pathExists(destinationRoot))) await cp(skill.rootPath, destinationRoot, { recursive: true, errorOnExist: true });
      destinationFile = path.join(destinationRoot, 'SKILL.md');
    }
    await writeFile(destinationFile, input.content, 'utf8');
    await ctx.refreshManagedSkills();
    return { canceled: false, path: destinationFile };
  });
  ipcMain.handle(IPC.importSkill, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = ImportSkillInputSchema.parse(raw ?? {});
    const selected = await dialog.showOpenDialog(ctx.mainWindow!, {
      title: input.replacePath ? '选择用于更新 Skill 的目录或 SKILL.md' : '导入 Skill',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Agent Skill', extensions: ['md'] }]
    });
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
    const selectedPath = selected.filePaths[0];
    const selectedInfo = await stat(selectedPath);
    const sourceRoot = selectedInfo.isDirectory() ? selectedPath : path.dirname(selectedPath);
    const sourceFile = path.join(sourceRoot, 'SKILL.md');
    const sourceInfo = await stat(sourceFile);
    if (!sourceInfo.isFile() || sourceInfo.size > 480_000) throw new Error('导入的 SKILL.md 过大。');
    const metadata = parseSkillSource(sourceFile, await readFile(sourceFile, 'utf8'));
    let destinationRoot = path.join(app.getPath('userData'), 'skills', metadata.id);
    if (input.replacePath) {
      const current = ctx.visibleSkill(input.replacePath);
      if (current.id !== metadata.id) throw new Error(`更新包的 Skill ID 为 ${metadata.id}，与当前 ${current.id} 不一致。`);
      if (current.origin !== 'default') destinationRoot = current.rootPath;
    } else if (await ctx.pathExists(destinationRoot)) {
      const confirmation = await dialog.showMessageBox(ctx.mainWindow!, {
        type: 'warning',
        buttons: ['更新现有 Skill', '取消'],
        defaultId: 0,
        cancelId: 1,
        message: `用户 Skill“${metadata.name}”已存在`,
        detail: '继续会将旧目录移入废纸篓，再导入新版本（包括 scripts、templates 和 references）。'
      });
      if (confirmation.response !== 0) return { canceled: true };
    }
    await ctx.replaceSkillDirectory(sourceRoot, destinationRoot);
    await ctx.refreshManagedSkills();
    return { canceled: false, path: path.join(destinationRoot, 'SKILL.md') };
  });
  ipcMain.handle(IPC.exportSkill, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = SkillPathInputSchema.parse(raw);
    const skill = ctx.visibleSkill(input.path);
    const selected = await dialog.showSaveDialog(ctx.mainWindow!, {
      title: '导出 Skill 目录',
      defaultPath: path.join(app.getPath('downloads'), path.basename(skill.rootPath)),
      buttonLabel: '导出'
    });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    if (await ctx.pathExists(selected.filePath)) throw new Error('导出目标已存在，请选择一个新目录。');
    await cp(skill.rootPath, selected.filePath, { recursive: true, errorOnExist: true });
    return { canceled: false, path: selected.filePath };
  });
  ipcMain.handle(IPC.trashSkill, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = SkillPathInputSchema.parse(raw);
    const skill = ctx.visibleSkill(input.path);
    if (skill.origin === 'default') throw new Error('默认 Skill 不能删除；可创建同名用户 Skill 进行覆盖。');
    const expectedFile = path.join(skill.rootPath, 'SKILL.md');
    if (path.resolve(expectedFile) !== path.resolve(skill.path)) throw new Error('拒绝删除无效的 Skill 根目录。');
    await shell.trashItem(skill.rootPath);
    await ctx.refreshManagedSkills();
    return { canceled: false, path: skill.rootPath };
  });
  ipcMain.handle(IPC.saveExtensionSettings, async (event, raw) => {
    ctx.assertTrusted(event);
    const extensions = SaveExtensionSettingsInputSchema.parse(raw);
    const apiKeys = await ctx.readApiKeys();
    const current = await ctx.configStore.get(apiKeys);
    await ctx.configStore.save({ ...current, extensions });
    await ctx.pushConfig();
    return extensions;
  });

}
