const mime = require('mime-types');

/**
 * Determine the safest file extension to use for raw content.
 *
 * Priority (fastest → most reliable):
 * 1. Content-Type header
 * 2. Magic bytes (file-type)
 * 3. Content heuristics (XML/HTML/Markdown)
 * 4. URL extension
 *
 * @param {Buffer|string} body
 * @param {Object} headers
 * @param {string} url
 * @returns {{ ext: string, mime?: string, isText?: boolean }}
 */
async function determineRawFileType(body, headers = {}, url = '') {
  const contentType = (headers['content-type'] || headers['Content-Type'] || '').toString().toLowerCase();
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8');

  // 1) Content-Type header
  if (contentType) {
    const extFromMime = mime.extension(contentType);
    if (extFromMime) {
      return {
        ext: extFromMime,
        mime: contentType,
        isText: !contentType.includes('pdf') && !contentType.includes('zip') && !contentType.includes('octet-stream'),
      };
    }

    if (contentType.includes('xml') || contentType.includes('rss')) {
      return { ext: 'xml', mime: contentType, isText: true };
    }
    if (contentType.includes('html')) {
      return { ext: 'html', mime: contentType, isText: true };
    }
    if (contentType.includes('json')) {
      return { ext: 'json', mime: contentType, isText: true };
    }
  }

  // 2) Magic bytes detection
  try {
    const { fileTypeFromBuffer } = await import('file-type');
    const fileType = await fileTypeFromBuffer(buffer.slice(0, 4100));
    if (fileType && fileType.ext) {
      return { ext: fileType.ext, mime: fileType.mime, isText: false };
    }
  } catch (e) {
    // ignore
  }

  // 3) Content heuristics (text-based)
  const textSample = buffer.toString('utf8', 0, 2000).trim();
  if (textSample.startsWith('<?xml') || textSample.includes('<rss') || textSample.includes('<feed')) {
    return { ext: 'xml', mime: 'application/xml', isText: true };
  }
  if (textSample.startsWith('<!DOCTYPE html') || textSample.includes('<html') || textSample.includes('<head')) {
    return { ext: 'html', mime: 'text/html', isText: true };
  }
  if (/^#{1,6}\s|^[a-z0-9-]+\s*:\s/i.test(textSample)) {
    return { ext: 'md', mime: 'text/markdown', isText: true };
  }

  // 4) URL extension fallback
  if (typeof url === 'string') {
    const parts = url.split('?')[0].split('#')[0].split('.');
    const guess = parts[parts.length - 1].toLowerCase();
    const known = { pdf: 'pdf', doc: 'doc', docx: 'docx', xml: 'xml', html: 'html', htm: 'html', md: 'md', json: 'json' };
    if (known[guess]) {
      return { ext: known[guess], mime: mime.lookup(known[guess]) || undefined, isText: true };
    }
  }

  return { ext: 'bin', mime: 'application/octet-stream', isText: false };
}

module.exports = determineRawFileType;
