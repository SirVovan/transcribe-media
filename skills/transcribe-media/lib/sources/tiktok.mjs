import { inspectMetadata, metadataSource } from './yt-dlp.mjs';
export async function inspectTikTok(input, options) { return metadataSource('tiktok', input, await inspectMetadata(input, options)); }
