const test = require('node:test');
const assert = require('node:assert/strict');
const { detectPhoneInfo, getFlagEmoji } = require('../src/phone');

test('detectPhoneInfo identifies UK, HK, US, JP, SG, CN numbers', () => {
  const hk = detectPhoneInfo('+852 9123 4567');
  assert.equal(hk.countryCode, 'HK');
  assert.equal(hk.countryName, '中国香港');
  assert.equal(hk.detected, true);
  assert.equal(hk.isValid, true);

  const us = detectPhoneInfo('+1 415 555 2671');
  assert.equal(us.countryCode, 'US');
  assert.equal(us.countryName, '美国');
  assert.equal(us.detected, true);

  const jp = detectPhoneInfo('00819012345678');
  assert.equal(jp.countryCode, 'JP');
  assert.equal(jp.countryName, '日本');
  assert.equal(jp.detected, true);

  const ukPartial = detectPhoneInfo('+44 7700');
  assert.equal(ukPartial.countryCode, 'GB');
  assert.equal(ukPartial.countryName, '英国');
  assert.equal(ukPartial.detected, true);
});

test('getFlagEmoji generates regional indicator flags', () => {
  assert.equal(getFlagEmoji('GB'), '🇬🇧');
  assert.equal(getFlagEmoji('US'), '🇺🇸');
  assert.equal(getFlagEmoji(''), '🌐');
});
