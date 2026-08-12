import { describe, expect, it } from 'vitest';
import {
  briefingSentMessage,
  buildBriefingToggleUpdate,
  buildCadenceUpdate,
  buildDeliveryUpdate,
  buildTokenUpdate,
  canSendTestBriefing,
  deliveryDirty,
  digitsOnly,
  lastBriefingLabel,
} from '../src/components/settings/briefingHelpers';

const ELIGIBLE = {
  briefingsEnabled: true,
  briefingWhatsappRecipient: '15551234567',
  briefingWhatsappPhoneNumberId: '123456789012345',
  briefingWhatsappTokenSet: true,
};

describe('digitsOnly', () => {
  it('keeps a digits-only string as-is', () => {
    expect(digitsOnly('15551234567')).toBe('15551234567');
  });

  it('strips formatting from a pasted international number', () => {
    expect(digitsOnly('+1 (555) 123-4567')).toBe('15551234567');
  });

  it('strips letters and whitespace entirely', () => {
    expect(digitsOnly('call me')).toBe('');
    expect(digitsOnly('')).toBe('');
  });

  it('preserves leading zeros (never a numeric parse)', () => {
    expect(digitsOnly('0044 20 7946 0958')).toBe('00442079460958');
  });
});

describe('canSendTestBriefing', () => {
  it('is true only with briefings on, recipient, phone number ID, and a stored token', () => {
    expect(canSendTestBriefing(ELIGIBLE)).toBe(true);
  });

  it('is false when briefings are disabled, even fully configured', () => {
    expect(canSendTestBriefing({ ...ELIGIBLE, briefingsEnabled: false })).toBe(false);
  });

  it('is false without a recipient', () => {
    expect(canSendTestBriefing({ ...ELIGIBLE, briefingWhatsappRecipient: '' })).toBe(false);
  });

  it('treats a whitespace-only recipient or phone number ID as missing', () => {
    expect(canSendTestBriefing({ ...ELIGIBLE, briefingWhatsappRecipient: '   ' })).toBe(false);
    expect(canSendTestBriefing({ ...ELIGIBLE, briefingWhatsappPhoneNumberId: ' ' })).toBe(false);
  });

  it('is false without a phone number ID', () => {
    expect(canSendTestBriefing({ ...ELIGIBLE, briefingWhatsappPhoneNumberId: '' })).toBe(false);
  });

  it('is false without a stored token', () => {
    expect(canSendTestBriefing({ ...ELIGIBLE, briefingWhatsappTokenSet: false })).toBe(false);
  });
});

describe('update builders', () => {
  it('toggle update carries only the enabled flag', () => {
    expect(buildBriefingToggleUpdate(true)).toEqual({ briefingsEnabled: true });
    expect(buildBriefingToggleUpdate(false)).toEqual({ briefingsEnabled: false });
  });

  it('cadence update carries only the cadence', () => {
    expect(buildCadenceUpdate('daily')).toEqual({ briefingCadence: 'daily' });
    expect(buildCadenceUpdate('weekly')).toEqual({ briefingCadence: 'weekly' });
  });

  it('delivery update normalizes the recipient to digits and trims the phone number ID', () => {
    expect(buildDeliveryUpdate('+1 (555) 123-4567', ' 123456789012345 ')).toEqual({
      briefingWhatsappRecipient: '15551234567',
      briefingWhatsappPhoneNumberId: '123456789012345',
    });
  });

  it('delivery update allows clearing both fields', () => {
    expect(buildDeliveryUpdate('', '')).toEqual({
      briefingWhatsappRecipient: '',
      briefingWhatsappPhoneNumberId: '',
    });
  });
});

describe('deliveryDirty', () => {
  const saved = { recipient: '15551234567', phoneNumberId: '123456789012345' };

  it('is false when drafts match the saved values', () => {
    expect(
      deliveryDirty({ recipient: '15551234567', phoneNumberId: '123456789012345' }, saved),
    ).toBe(false);
  });

  it('is false when drafts differ only by formatting/whitespace that saving would strip', () => {
    expect(
      deliveryDirty({ recipient: '+1 555 123 4567', phoneNumberId: ' 123456789012345 ' }, saved),
    ).toBe(false);
  });

  it('is true when the recipient changes', () => {
    expect(
      deliveryDirty({ recipient: '15559990000', phoneNumberId: '123456789012345' }, saved),
    ).toBe(true);
  });

  it('is true when the phone number ID changes', () => {
    expect(deliveryDirty({ recipient: '15551234567', phoneNumberId: '999' }, saved)).toBe(true);
  });

  it('is true when clearing a saved value', () => {
    expect(deliveryDirty({ recipient: '', phoneNumberId: '123456789012345' }, saved)).toBe(true);
  });
});

describe('buildTokenUpdate', () => {
  it('stores a trimmed token when the draft is non-blank', () => {
    expect(buildTokenUpdate('  EAAtoken123  ', false)).toEqual({
      briefingWhatsappToken: 'EAAtoken123',
    });
    expect(buildTokenUpdate('EAAtoken123', true)).toEqual({
      briefingWhatsappToken: 'EAAtoken123',
    });
  });

  it('clears the stored token when the draft is blank and one is stored (null-to-clear)', () => {
    expect(buildTokenUpdate('', true)).toEqual({ briefingWhatsappToken: null });
    expect(buildTokenUpdate('   ', true)).toEqual({ briefingWhatsappToken: null });
  });

  it('has nothing to save when the draft is blank and no token is stored', () => {
    expect(buildTokenUpdate('', false)).toBeNull();
    expect(buildTokenUpdate('   ', false)).toBeNull();
  });
});

describe('lastBriefingLabel', () => {
  it('is null when a briefing has never been sent', () => {
    expect(lastBriefingLabel(null)).toBeNull();
  });

  it('formats a real timestamp with toLocaleString (matching the Drive "Last synced" line)', () => {
    const iso = '2026-08-10T08:00:00.000Z';
    expect(lastBriefingLabel(iso)).toBe(`Last sent ${new Date(iso).toLocaleString()}`);
  });

  it('never renders an unparseable timestamp as "Invalid Date"', () => {
    expect(lastBriefingLabel('not-a-date')).toBeNull();
  });
});

describe('briefingSentMessage', () => {
  it('pins the exact success-toast copy around the server-confirmed recipient', () => {
    expect(briefingSentMessage('15551234567')).toBe('Briefing sent to 15551234567.');
  });
});
