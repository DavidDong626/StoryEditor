export const MAX_AVATAR_FILE = 5 * 1024 * 1024;
export const MAX_AVATAR_DATA = 350000;
export function avatarFormat(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  throw new Error('请选择 PNG、JPEG 或 WebP 图片，不支持 SVG 和 GIF。');
}
export async function importAvatar(file: File): Promise<string> {
  if (!file.size || file.size > MAX_AVATAR_FILE) throw new Error('头像原图必须小于或等于 5 MB。');
  const bytes = new Uint8Array(await file.arrayBuffer()),
    format = avatarFormat(bytes);
  const blob = new Blob([bytes], { type: format });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error('图片无法解码，请选择有效的图片文件。');
  }
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 50000000)
      throw new Error('图片尺寸过大，请缩小到 5000 万像素以内。');
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法处理图片。');
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      256,
      256,
    );
    const result = canvas.toDataURL('image/webp', 0.85);
    if (result.length > MAX_AVATAR_DATA) throw new Error('图片处理后仍过大，请换一张图片。');
    return result;
  } finally {
    bitmap.close();
  }
}
