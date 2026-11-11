"use client";

import { useFeatureFlag } from "acme-flags";

export function LocaleSwitch() {
  const enabled = useFeatureFlag("locale-switch");
  return enabled ? <a href="/ar">العربية</a> : null;
}
