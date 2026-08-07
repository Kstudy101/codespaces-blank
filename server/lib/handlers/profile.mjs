/* ==================================================================
   handlers/profile.mjs — プロフィール編集（plan-profile §2）

     GET  /profile/start   → LINE Login（purpose=edit）
     GET  /profile         → 本人確認済みフォーム
     POST /profile         → 保存 → LINE 確認 1 通

   コールバックは /line/callback を共用。purpose で分岐（app.mjs）。
   ================================================================== */
import { users } from "../repo/index.mjs";
import * as oauthStates from "../repo/oauth-states.mjs";
import { newState, hashState, looksLikeState } from "../token.mjs";
import { authorizeUrl, exchangeCode, loginProfile, revoke } from "../linelogin.mjs";
import { pushMessage } from "../line.mjs";
import { kanaNameToHangul } from "../kana2hangul.mjs";
import { cities } from "../fortune.mjs";
import { cityOf, timeUnknown } from "../onboarding.mjs";
import { normalizeProfile } from "./link.mjs";
import { issue, verify, cookieHeader, clearCookieHeader } from "../session.mjs";
import { jstDateTime } from "../jst.mjs";
import { profileFormPage, profileDonePage, profileGatePage } from "../pages.mjs";

const SITE_URL = process.env.SITE_URL || "https://www.kstudy101.jp";

/* LINE Login コールバックと同じホストの /profile/start */
export function profileStartUrl() {
  const base = process.env.LINE_LOGIN_REDIRECT_URI || "https://api.kstudy101.jp/line/callback";
  return base.replace(/\/line\/callback\/?$/, "/profile/start");
}

/* 編集を許す最小条件 ── 生年月日が確定している人だけ。
   未完了の人は LINE の段で直す（plan-profile §0）。 */
export function profileEligible(user, saju) {
  return !!(user && saju && saju.birth_date && saju.birth_confirmed);
}

export async function startProfileEdit(conn) {
  const state = newState();
  const now = jstDateTime();
  const expiresAt = jstDateTime(new Date(Date.now() + oauthStates.TTL_MINUTES * 60_000));
  await oauthStates.create(conn, hashState(state), "edit", { now, expiresAt });
  return { authorizeUrl: authorizeUrl(state) };
}

export async function completeProfileEdit(conn, { code, state, error, errorDescription }) {
  if (error) {
    return { ok: false, kind: "declined", reason: errorDescription || error };
  }
  if (!looksLikeState(state)) {
    return { ok: false, kind: "bad_state" };
  }
  if (!code || typeof code !== "string") {
    return { ok: false, kind: "bad_code" };
  }

  const now = jstDateTime();
  const purpose = await oauthStates.consume(conn, hashState(state), { now });
  if (purpose !== "edit") {
    return { ok: false, kind: "expired" };
  }

  let lineUserId, accessToken = null;
  try {
    const token = await exchangeCode(code);
    accessToken = token.access_token;
    const me = await loginProfile(accessToken);
    lineUserId = me.userId;
  } catch (e) {
    return { ok: false, kind: "exchange_failed", reason: e.message };
  } finally {
    if (accessToken) revoke(accessToken);
  }

  if (!lineUserId) {
    return { ok: false, kind: "no_user_id" };
  }

  const user = await users.findByLineUserId(conn, lineUserId);
  if (!user) {
    return { ok: false, kind: "no_account" };
  }

  const saju = await users.getSajuProfile(conn, user.id);
  if (!profileEligible(user, saju)) {
    return { ok: false, kind: "onboarding_incomplete" };
  }

  return {
    ok: true,
    setCookie: cookieHeader(issue(user.id)),
    redirect: "/profile"
  };
}

export async function loadProfileForm(conn, userId) {
  const user = await users.findById(conn, userId);
  if (!user) return { ok: false, kind: "no_user" };
  const saju = await users.getSajuProfile(conn, userId);
  if (!profileEligible(user, saju)) {
    return { ok: false, kind: "onboarding_incomplete" };
  }

  const cityId = cityOf({ raw_result_json: saju.raw_result_json });
  const cityList = cities();
  return {
    ok: true,
    html: profileFormPage({
      nameReading: user.name_reading || "",
      nameKr: user.name_kr || "",
      birthDate: saju.birth_date || "",
      birthTime: saju.birth_time ? String(saju.birth_time).slice(0, 5) : "",
      timeUnknown: timeUnknown({ raw_result_json: saju.raw_result_json }),
      gender: saju.gender || "U",
      cityId: cityId || "",
      cities: cityList,
      siteUrl: SITE_URL
    })
  };
}

function parseForm(body) {
  const p = new URLSearchParams(body);
  return {
    nameReading: p.get("name_reading"),
    birthDate: p.get("birth_date"),
    birthTime: p.get("birth_time"),
    timeUnknown: p.get("time_unknown") === "1",
    gender: p.get("gender"),
    cityId: p.get("city_id")
  };
}

export async function saveProfile(conn, userId, rawBody, { send = pushMessage } = {}) {
  const user = await users.findById(conn, userId);
  if (!user) return { ok: false, kind: "no_user" };

  const saju = await users.getSajuProfile(conn, userId);
  if (!profileEligible(user, saju)) {
    return { ok: false, kind: "onboarding_incomplete" };
  }

  const form = parseForm(rawBody);
  const norm = normalizeProfile({
    birthDate: form.birthDate,
    birthTime: form.timeUnknown ? null : form.birthTime,
    gender: form.gender
  });

  if (!norm.birthDate) {
    return { ok: false, kind: "bad_birth", html: profileGatePage("birth") };
  }

  const cityList = cities();
  const city = cityList.find((c) => c.id === form.cityId);
  if (!city) {
    return { ok: false, kind: "bad_city", html: profileGatePage("city") };
  }

  let nameReading = user.name_reading;
  let nameKr = user.name_kr;
  let nameKanji = user.name_kanji;

  const readingIn = form.nameReading != null ? String(form.nameReading).trim().slice(0, 50) : "";
  if (readingIn && readingIn !== (user.name_reading || "")) {
    const kr = kanaNameToHangul(readingIn);
    if (!kr) {
      return {
        ok: false,
        kind: "bad_name",
        html: profileFormPage({
          nameReading: readingIn,
          nameKr: user.name_kr || "",
          birthDate: norm.birthDate,
          birthTime: form.timeUnknown ? "" : (form.birthTime || ""),
          timeUnknown: form.timeUnknown,
          gender: norm.gender,
          cityId: city.id,
          cities: cityList,
          siteUrl: SITE_URL,
          error: "お名前（かな）を読み取れませんでした。もう一度お試しください。"
        })
      };
    }
    nameReading = readingIn;
    nameKr = kr;
    nameKanji = null;
  }

  const raw = saju.raw_result_json && typeof saju.raw_result_json === "object"
    ? { ...saju.raw_result_json } : {};
  raw.city = city.id;
  if (form.timeUnknown) {
    raw.birth_time_unknown = true;
  } else if (form.birthTime) {
    delete raw.birth_time_unknown;
  }

  await users.updateName(conn, userId, {
    nameKanji: nameKanji,
    nameReading: nameReading,
    nameKr: nameKr
  });

  await users.upsertSajuProfile(conn, userId, {
    birthDate: norm.birthDate,
    birthTime: norm.birthTime,
    gender: norm.gender,
    ohaengMain: saju.ohaeng_main,
    rawResult: raw
  });
  await users.setBirthConfirmed(conn, userId, true);

  const confirmText =
    "登録情報を更新しました。\n\n" +
    "運勢は次の朝の便から、お名前の変更は今夜の復習・明日の朝から反映されます。";

  try {
    await send(user.line_user_id, [{ type: "text", text: confirmText }]);
  } catch {
    /* 保存は完了。通知だけ失敗 ── 画面で完了を伝える */
  }

  return {
    ok: true,
    clearCookie: clearCookieHeader(),
    html: profileDonePage({ addFriendUrl: process.env.LINE_ADD_FRIEND_URL })
  };
}

export function gatePage(kind) {
  return profileGatePage(kind);
}
