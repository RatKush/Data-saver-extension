#!/usr/bin/env python3
"""Locale integrity check.

Three failures this catches, all of which have actually happened here:

  1. A key present in en but missing from a translation. chrome.i18n falls
     back to default_locale so nothing renders blank, but the UI silently
     ships half-English.
  2. Wrong-script leakage — a Chinese character inside a Russian string, the
     English word "connections" inside a Chinese description. Both shipped
     undetected before this scan existed.
  3. A placeholder that was translated away. If $COUNT$ becomes something
     else, chrome.i18n substitutes nothing and the sentence loses its number.

Run standalone or via scripts/verify.sh.
"""
import json
import glob
import os
import re
import sys
import unicodedata

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

# Locales written in the Latin alphabet; anything else in them is suspect.
LATIN = {'de', 'en', 'es', 'fil', 'fr', 'id', 'it', 'ms', 'pt_BR', 'sw', 'tr', 'vi'}

# Scripts each non-Latin locale may legitimately use. Japanese mixes three,
# and KATAKANA-HIRAGANA is the prolonged sound mark (U+30FC).
ALLOWED = {
    'ar': {'ARABIC'}, 'fa': {'ARABIC'},
    'ru': {'CYRILLIC'}, 'uk': {'CYRILLIC'},
    'hi': {'DEVANAGARI'}, 'mr': {'DEVANAGARI'},
    'bn': {'BENGALI'}, 'ta': {'TAMIL'}, 'te': {'TELUGU'}, 'th': {'THAI'},
    'ja': {'CJK', 'HIRAGANA', 'KATAKANA', 'KATAKANA-HIRAGANA'},
    'ko': {'HANGUL', 'CJK'},
    'zh_CN': {'CJK'},
}

# Latin that is correct in every locale: product and format names, plus the
# borrowed term "cookie", which is what Google's own ru/uk UI uses.
ALLOW_WORDS = ['Data Saver', 'Data', 'Saver', 'JSON', 'Premium', 'cookie', 'Cookie']

PLACEHOLDER = re.compile(r'\$[A-Za-z0-9_]+\$')


def scripts_used(text):
    out = set()
    for ch in text:
        if not ch.isalpha():
            continue
        try:
            out.add(unicodedata.name(ch).split()[0])
        except ValueError:
            pass
    return out


def main():
    files = sorted(glob.glob(os.path.join(ROOT, '_locales', '*', 'messages.json')))
    if not files:
        print('no locales found')
        return 1

    en_path = os.path.join(ROOT, '_locales', 'en', 'messages.json')
    with open(en_path, encoding='utf-8') as fh:
        en = json.load(fh)

    problems = []

    for path in files:
        loc = os.path.basename(os.path.dirname(path))
        with open(path, encoding='utf-8') as fh:
            msgs = json.load(fh)

        for key in sorted(set(en) - set(msgs)):
            problems.append(f'{loc}: missing key {key}')
        for key in sorted(set(msgs) - set(en)):
            problems.append(f'{loc}: key {key} is not in en')

        for key, entry in msgs.items():
            message = entry.get('message', '')

            # Placeholders must survive translation intact.
            expected = set(PLACEHOLDER.findall(en.get(key, {}).get('message', '')))
            actual = set(PLACEHOLDER.findall(message))
            if expected and expected != actual:
                problems.append(
                    f'{loc}.{key}: placeholders {sorted(expected)} became {sorted(actual) or "none"}')
            if expected and 'placeholders' not in entry:
                problems.append(f'{loc}.{key}: uses {sorted(expected)} but declares no placeholders')

            probe = PLACEHOLDER.sub('', message)
            for word in ALLOW_WORDS:
                probe = probe.replace(word, '')

            used = scripts_used(probe)
            stray = ({s for s in used if s != 'LATIN'} if loc in LATIN
                     else {s for s in used if s not in ALLOWED.get(loc, set())})
            if stray:
                problems.append(f'{loc}.{key}: {sorted(stray)} in "{message[:48]}"')

    if problems:
        for p in problems:
            print(f'  {p}')
        print(f'\n{len(problems)} locale problem(s)')
        return 1

    print(f'{len(files)} locales, {len(en)} keys each, scripts and placeholders clean')
    return 0


if __name__ == '__main__':
    sys.exit(main())
