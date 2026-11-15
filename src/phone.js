const {
  parsePhoneNumberFromString,
  AsYouType,
  getCountries,
  getCountryCallingCode,
} = require('libphonenumber-js/max');

const regionNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' });

// For shared calling codes, prefer the primary country when only prefix/partial digits are given
const PRIMARY_COUNTRY_BY_CALLING_CODE = {
  '1': 'US',
  '7': 'RU',
  '39': 'IT',
  '44': 'GB',
  '47': 'NO',
  '61': 'AU',
  '212': 'MA',
  '262': 'RE',
  '358': 'FI',
  '590': 'GP',
  '599': 'CW',
};

const callingCodeToCountries = new Map();
for (const country of getCountries()) {
  const code = getCountryCallingCode(country);
  if (!callingCodeToCountries.has(code)) {
    callingCodeToCountries.set(code, []);
  }
  callingCodeToCountries.get(code).push(country);
}

// Sort calling codes longest-first for prefix matching (e.g. 852 before 85, 886 before 88)
const sortedCallingCodes = Array.from(callingCodeToCountries.keys()).sort(
  (a, b) => b.length - a.length
);

const COUNTRY_NAME_ALIASES = {
  HK: '中国香港',
  MO: '中国澳门',
  TW: '中国台湾',
};

function getCountryName(countryCode) {
  if (!countryCode) return '';
  if (COUNTRY_NAME_ALIASES[countryCode]) {
    return COUNTRY_NAME_ALIASES[countryCode];
  }
  try {
    return regionNames.of(countryCode) || countryCode;
  } catch {
    return countryCode;
  }
}

function getFlagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) return '🌐';
  const upper = countryCode.toUpperCase();
  const codePoints = [...upper].map((char) => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

function normalizePhoneInput(raw) {
  if (typeof raw !== 'string') return '';
  let cleaned = raw.trim().replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('00')) {
    cleaned = '+' + cleaned.slice(2);
  }
  return cleaned;
}

function detectCountryFromPrefix(normalized) {
  if (!normalized.startsWith('+')) return null;
  const digits = normalized.slice(1).replace(/\D/g, '');
  if (!digits) return null;

  for (const code of sortedCallingCodes) {
    if (digits.startsWith(code)) {
      if (PRIMARY_COUNTRY_BY_CALLING_CODE[code]) {
        return PRIMARY_COUNTRY_BY_CALLING_CODE[code];
      }
      const list = callingCodeToCountries.get(code);
      if (list && list.length > 0) {
        return list[0];
      }
    }
  }
  return null;
}

/**
 * Parse a phone number and detect its country/region.
 * Works both for complete numbers (+447911123456) and partial prefixes (+852, +44).
 */
function detectPhoneInfo(rawInput) {
  const input = typeof rawInput === 'string' ? rawInput.trim() : '';
  const normalized = normalizePhoneInput(input);

  if (!normalized) {
    return {
      input,
      normalized: '',
      formatted: '',
      countryCode: '',
      countryName: '',
      flag: '🌐',
      callingCode: '',
      isValid: false,
      detected: false,
    };
  }

  // Try full parse first (if user didn't include '+', also try prepending '+' for international numbers)
  const candidate = normalized.startsWith('+') ? normalized : `+${normalized}`;
  const parsed = parsePhoneNumberFromString(candidate);

  let countryCode = parsed?.country || '';
  let callingCode = parsed?.countryCallingCode || '';

  if (!countryCode) {
    const ayt = new AsYouType();
    ayt.input(candidate);
    countryCode = ayt.getCountry() || '';
    if (!callingCode && ayt.getCallingCode()) {
      callingCode = ayt.getCallingCode();
    }
  }

  if (!countryCode && callingCode && PRIMARY_COUNTRY_BY_CALLING_CODE[callingCode]) {
    countryCode = PRIMARY_COUNTRY_BY_CALLING_CODE[callingCode];
  }

  if (!countryCode) {
    countryCode = detectCountryFromPrefix(candidate) || '';
  }

  const countryName = getCountryName(countryCode);
  const flag = getFlagEmoji(countryCode);
  const formatted = parsed ? parsed.formatInternational() : input;
  const isValid = Boolean(parsed && parsed.isValid());

  return {
    input,
    normalized: parsed ? parsed.number : candidate,
    formatted,
    countryCode,
    countryName,
    flag,
    callingCode,
    isValid,
    detected: Boolean(countryCode),
  };
}

module.exports = {
  detectPhoneInfo,
  getCountryName,
  getFlagEmoji,
  normalizePhoneInput,
};
