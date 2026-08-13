import { describe, expect, it } from 'vitest';
import { BUILD_ID, shouldOfferReload } from '../shared/version';

describe('BUILD_ID', () => {
  it('resolves to the id vitest.config.ts defines, proving the define flows through', () => {
    expect(BUILD_ID).toBe('test-build');
  });
});

describe('shouldOfferReload', () => {
  it('offers nothing when the server has not reported a build id (older server)', () => {
    expect(shouldOfferReload('client-a', undefined, null)).toBe(false);
  });

  it('offers nothing when the server build id is null (never fetched)', () => {
    expect(shouldOfferReload('client-a', null, null)).toBe(false);
  });

  it('offers nothing when the server matches this tab\'s own build', () => {
    expect(shouldOfferReload('client-a', 'client-a', null)).toBe(false);
  });

  it('offers a reload when the server build id differs from this tab\'s build', () => {
    expect(shouldOfferReload('client-a', 'client-b', null)).toBe(true);
  });

  it('suppresses the offer once the user dismissed this exact deploy', () => {
    expect(shouldOfferReload('client-a', 'client-b', 'client-b')).toBe(false);
  });

  it('offers again when a later, different deploy follows a dismissal', () => {
    expect(shouldOfferReload('client-a', 'client-c', 'client-b')).toBe(true);
  });
});
