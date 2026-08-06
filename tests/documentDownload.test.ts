import { describe, expect, it } from 'vitest';
import { resolveDownloadDisposition } from '../worker/documents';

describe('resolveDownloadDisposition', () => {
  it('allows inline only for a PDF when inline was actually requested', () => {
    expect(resolveDownloadDisposition('application/pdf', true)).toBe('inline');
  });

  it('forces attachment for every other mime type even when inline is requested', () => {
    // Security-critical case: an uploaded file's mimeType is entirely
    // client-declared and never validated against real content. Serving
    // text/html or image/svg+xml inline on the app's own origin (no CSP)
    // would execute script with access to every API endpoint, including the
    // ledger. Attachment disposition is what makes unvalidated MIME storage
    // safe — it must never be bypassed for anything but a real PDF.
    expect(resolveDownloadDisposition('text/html', true)).toBe('attachment');
    expect(resolveDownloadDisposition('image/svg+xml', true)).toBe('attachment');
    expect(resolveDownloadDisposition('image/jpeg', true)).toBe('attachment');
    expect(resolveDownloadDisposition('application/octet-stream', true)).toBe('attachment');
    expect(resolveDownloadDisposition('application/pdf; charset=binary', true)).toBe('attachment'); // exact match only
  });

  it('defaults to attachment when inline was not requested, regardless of mime type', () => {
    expect(resolveDownloadDisposition('application/pdf', false)).toBe('attachment');
    expect(resolveDownloadDisposition('image/jpeg', false)).toBe('attachment');
  });
});
