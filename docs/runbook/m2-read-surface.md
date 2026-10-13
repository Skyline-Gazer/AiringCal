# M2 — read surface verification

After QingLong sync succeeds (M1), align **read** Worker with latest bundle + frontend.

## Checklist

1. **Bundle** — AiringCal `dev` CI artifact ≥ PR #55 (calendar large enrich).
2. **Deploy** — `apps/web-worker` to `airing-cal-frontend`; check `GET /api/version`.
3. **API smoke**
   - `GET /api/collections?type=watching&limit=5` → `data[]`
   - `GET /api/calendar` → weekday arrays
   - `GET /image/{hash}` for a known cover hash
4. **UI** — Same `subject_id`: 番组计划 vs 放送日历 `images.large` / widget clarity.
5. **Cron** — QingLong sync `0 20 * * *` UTC; backup optional `30 4 * * 0`.

## QingLong doc

[operator-checklist](https://github.com/Skyline-Gazer/QINGLONG-REPO/blob/ql/docs/usage/airingcal-operator-checklist.md)
