import { describe, expect, it } from 'vitest';
import { avatarFormat, importAvatar } from './avatar';
import { projectSchema } from './model';
import { sampleProject } from './sample';
import { backup, importBackup, runtimeExport } from './transfer';
const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=';
describe('角色头像导入与兼容', () => {
  it('按真实文件签名识别支持的图片，拒绝 SVG 与伪装扩展名', () => {
    expect(avatarFormat(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))).toBe('image/png');
    expect(avatarFormat(new Uint8Array([255, 216, 255]))).toBe('image/jpeg');
    expect(avatarFormat(new TextEncoder().encode('RIFFxxxxWEBP'))).toBe('image/webp');
    expect(() => avatarFormat(new TextEncoder().encode('<svg onload="alert(1)"/>'))).toThrow();
  });
  it('旧项目无头像仍可读取，头像进入备份和运行导出且引用不变', () => {
    const project = sampleProject();
    expect(projectSchema.safeParse(project).success).toBe(true);
    project.characters[0].avatar = image;
    const imported = importBackup(JSON.stringify(backup(project)));
    expect(imported.characters[0].avatar).toBe(image);
    expect(imported.characters[0].id).toBe(project.characters[0].id);
    expect(runtimeExport(project).characters[0].avatar).toBe(image);
  });
  it('服务端共用模型拒绝远程 URL、脚本格式和过大的头像', () => {
    const project = sampleProject();
    for (const avatar of [
      'https://example.com/private.jpg',
      'data:image/svg+xml;base64,PHN2Zy8+',
      'data:image/png;base64,' + 'A'.repeat(350000),
    ]) {
      project.characters[0].avatar = avatar;
      expect(projectSchema.safeParse(project).success).toBe(false);
    }
  });
  it('在解码前拒绝空文件和超出 5 MB 的文件', async () => {
    await expect(importAvatar(new File([], 'empty.png'))).rejects.toThrow('5 MB');
    await expect(importAvatar(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png'))).rejects.toThrow(
      '5 MB',
    );
  });
});
