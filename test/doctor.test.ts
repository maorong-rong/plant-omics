import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PACKAGE_NAMES,
  defaultInstalledDirs,
  findInstalled,
  isInstalledPluginDir,
  resolveInstalledDir,
} from '../scripts/doctor.mjs';

/**
 * doctor 的定位层测试（2026-11-07 修旧包名假阴性时补）。
 *
 * 为什么要单测：这个脚本的唯一职责就是发现「装了但跑的不是当前构建」，
 * 结果自己只查旧包名 `dsh-plugin-plant-omics`，对当前 `plantomics-hub` 报「找不到」——
 * 假阴性会让它看起来永远没装。定位逻辑必须能接受新包名、profile 目录与插件目录两种输入，
 * 且旧包名继续兼容。
 *
 * 只测纯定位函数，不跑整份比对（`npm test` 在 `npm run build` 之前，没有 dist/ 可比）。
 */

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTemp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'doctor-test-'));
  tmpDirs.push(dir);
  return dir;
}

/** 造一个「已装插件」目录：package.json + dist/。 */
function makePluginDir(root: string, name = 'plantomics-hub'): string {
  const dir = path.join(root, 'node_modules', name);
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.1.2' }));
  writeFileSync(path.join(dir, 'dist', 'index.js'), 'export const ready = true;\n');
  return dir;
}

describe('doctor 定位：当前包名 plantomics-hub', () => {
  it('profile 目录下有当前包 → 解析到 node_modules/plantomics-hub', () => {
    const profile = makeTemp();
    const installed = makePluginDir(profile, 'plantomics-hub');
    expect(resolveInstalledDir(profile)).toBe(installed);
  });

  it('直接给插件目录也接受（含 package.json + dist）', () => {
    const profile = makeTemp();
    const installed = makePluginDir(profile, 'plantomics-hub');
    expect(resolveInstalledDir(installed)).toBe(installed);
  });

  it('旧包名保留兼容：只有 dsh-plugin-plant-omics 时仍能找到', () => {
    const profile = makeTemp();
    const legacy = makePluginDir(profile, 'dsh-plugin-plant-omics');
    expect(resolveInstalledDir(profile)).toBe(legacy);
  });

  it('新包名与旧包名同时在：优先当前包', () => {
    const profile = makeTemp();
    makePluginDir(profile, 'dsh-plugin-plant-omics');
    const current = makePluginDir(profile, 'plantomics-hub');
    expect(resolveInstalledDir(profile)).toBe(current);
  });

  it('只有 package.json、没有 dist/ 不算已装（profile 根目录不会被误认）', () => {
    const profile = makeTemp();
    writeFileSync(path.join(profile, 'package.json'), '{"name":"profile"}');
    expect(resolveInstalledDir(profile)).toBeUndefined();
    expect(isInstalledPluginDir(profile)).toBe(false);
  });

  it('目录不存在时返回 undefined，不静默换成默认目录', () => {
    expect(resolveInstalledDir(path.join(makeTemp(), 'missing'))).toBeUndefined();
  });
});

describe('doctor 默认位置', () => {
  it('跟随 DSH_PROFILE_DIR / DSH_PROFILE / desktop，并新包名优先', () => {
    const home = makeTemp();
    const dirs = defaultInstalledDirs({
      DSH_HOME: home,
      DSH_PROFILE: 'superagent',
      DSH_PROFILE_DIR: path.join(home, 'profiles', 'superagent'),
    });

    expect(dirs).toEqual([
      path.join(home, 'profiles', 'superagent', 'node_modules', 'plantomics-hub'),
      path.join(home, 'profiles', 'superagent', 'node_modules', 'dsh-plugin-plant-omics'),
      path.join(home, 'profiles', 'desktop', 'node_modules', 'plantomics-hub'),
      path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-plugin-plant-omics'),
    ]);
    expect(PACKAGE_NAMES).toEqual(['plantomics-hub', 'dsh-plugin-plant-omics']);
  });

  it('没有 DSH_HOME 时默认 ~/.dsh 的 desktop profile（不写死用户名）', () => {
    const dirs = defaultInstalledDirs({});
    expect(dirs.some((dir) => dir.endsWith(path.join('.dsh', 'profiles', 'desktop', 'node_modules', 'plantomics-hub'))))
      .toBe(true);
  });

  it('findInstalled 在默认位置里找到当前包', () => {
    const home = makeTemp();
    const profileDir = path.join(home, 'profiles', 'superagent');
    const installed = makePluginDir(profileDir, 'plantomics-hub');
    expect(findInstalled(undefined, { DSH_HOME: home, DSH_PROFILE: 'superagent', DSH_PROFILE_DIR: profileDir }))
      .toBe(installed);
  });

  it('--installed 覆盖优先于默认位置', () => {
    const home = makeTemp();
    makePluginDir(path.join(home, 'profiles', 'desktop'), 'plantomics-hub');
    const tmpProfile = makeTemp();
    const installed = makePluginDir(tmpProfile, 'plantomics-hub');
    expect(findInstalled(tmpProfile, { DSH_HOME: home })).toBe(installed);
  });
});
