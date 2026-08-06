# Research: Open-Source Finance Landscape & License Strategy (August 2026)

*Compiled by an AI research pass, August 2026. Sources cited inline; items the
researcher could not verify are flagged. Summarized conclusions feed
[docs/VISION.md](../VISION.md).*

## Summary

The OSS personal-finance space has consolidated around a handful of stable,
AGPL-3.0-licensed self-hosted apps (Firefly III, Ghostfolio, the Maybe→Sure
lineage) plus one MIT outlier (Actual Budget) whose creator deliberately opted
out of running a business around it — and third parties captured the hosting
revenue instead. Separately: OpenAI shipped bank-linked, Plaid-powered
personal-finance features directly inside ChatGPT in May–June 2026 and
partnered with Intuit — the AI-finance whitespace is being claimed by a
well-capitalized incumbent, which shapes how Ledgerly differentiates
(privacy/self-hosted/local AI, not breadth of bank connectivity). For
licensing, AGPL-3.0 is the clear default given precedent, defensibility
against a future hosted competitor, and low downside for an end-user app.

## 1. Landscape

| Project | License | Scale (stars) | Monetization | Trajectory | Niche |
|---|---|---|---|---|---|
| Actual Budget | MIT | ~28.0k | No official hosted SaaS; donations. Third parties (PikaPods ~$2/mo "over 8,000 users", Fly.io) monetize hosting instead. | Creator shut the commercial product and open-sourced in 2022. 2026 roadmap: plugins, mobile parity. Community/donation-run. | Envelope budgeting / YNAB alternative; local-first, privacy-first. |
| Firefly III | AGPL-3.0 | ~24.2k | None — self-host only. | 10+ years, largely single core maintainer. | Power-user double-entry with a rules engine. Complaints: manual-only import, no official mobile app, setup friction. |
| Maybe → Sure | AGPL-3.0 | Maybe (archived): 54.3k; Sure fork: ~9.3k | Maybe raised ~$1.4–1.9M (inexact across sources — flagged), ran a paid hosted version, found it unsustainable. | Development stopped mid-2023; repo archived Jul 27, 2025; company pivoted to B2B forecasting; community forked as "Sure" (Maybe Inc. kept the trademark). | Bank-linked wealth tracking. **Cautionary tale: open-sourcing saved the code, not the company.** |
| Ghostfolio | AGPL-3.0 | ~8–9k (approx.) | Real hosted product: Premium ~€9/mo — the closest working maintainer-run open-core-lite SaaS in the space. | Actively developed, small team. | Investment portfolio / net-worth tracking. |
| New entrants | mixed | small/unverified | — | ezBookkeeping, Squirrel, YAFFA, "WiseCashAI" surfaced on lists; traction unverified. | — |

**Cross-project pain points:** weak/absent automated bank sync; second-class
mobile; self-host setup friction; weak multi-user support; **no native AI
features in any of the big four** (third-party plugins only) — real whitespace.

**Competitive signal:** OpenAI launched bank-linked personal finance inside
ChatGPT May 15, 2026 (Pro), expanding to Plus by June 30, 2026 — 12,000+
institutions via Plaid, after acquiring the Hiro team and partnering with
Intuit ([TechCrunch](https://techcrunch.com/2026/05/15/openai-launches-chatgpt-for-personal-finance-will-let-you-connect-bank-accounts/),
[9to5Mac](https://9to5mac.com/2026/06/30/openai-just-released-new-personal-finance-features-for-chatgpt-customers/),
[American Banker](https://www.americanbanker.com/news/openai-launches-personal-finance-tools-for-chatgpt-pro-users)).

## 2. License strategy

- Every finance-adjacent OSS project with a hosted arm chose **AGPL-3.0**
  (Firefly III, Ghostfolio, Maybe/Sure; outside finance: Plausible's server,
  Documenso, Cal.com core). The MIT outlier (Actual) has no owner-run cloud —
  third parties capture that layer.
- Industry pattern: MongoDB (2018), Elastic (2021), HashiCorp (2023), Redis
  (2024) all started permissive, watched clouds capture hosting revenue, and
  relicensed reactively at community cost.
- AGPL's enterprise-friction cost applies mainly to embeddable
  infra/libraries; Ledgerly is an end-user app self-hosters run directly —
  Firefly III and Ghostfolio's userbases prove the audience doesn't mind.
- Fair-source (FSL/BSL) blocks hosted competitors but is **not OSI-approved**
  — costs directory listings (awesome-selfhosted etc.) and launch trust.

**Recommendation: AGPL-3.0 now**, with the Cal.com-style option later of a
separately-licensed enterprise directory for genuinely business-tier features
(multi-tenant admin, SSO, team seats) while the personal core stays AGPL.

## 3. Open-core → SaaS playbook

- **Plausible** (bootstrapped, no VC): ~$3.1M ARR 2024 → ~$3.5M 2025. Server
  AGPL; the embeddable tracker snippet deliberately MIT (license by
  component). Growth via "Google Analytics alternative" SEO, not stars.
- **Cal.com**: AGPL core + proprietary `packages/features/ee/`; VC-backed;
  useful as an architectural reference, not a solo-builder precedent.
- **Documenso**: AGPL, hosted freemium, $2.2M funding; revenue unverified.
- Pattern: same codebase self-hosted and hosted; paid tier sells
  convenience/teams, never ransoms basic features; growth = content/SEO;
  1–2+ years of full-time work before revenue mattered.
- Reality check: the median outcome is thousands of stars, unpaid weekend
  maintenance, and burnout risk — not Plausible.

## 4. Launch requirements

Hygiene: LICENSE **before** first public commit; README with real
screenshot/GIF; CONTRIBUTING + CODE_OF_CONDUCT; genuine self-host docs (one
Docker/deploy command is the bar); a live demo instance. Show HN mechanics:
Tue–Thu 8–10am PT, author's detailed first comment within 5 minutes,
cross-post ~30 min later, respond to everything for 48h.

First-90-days failure modes: bus-factor-1 with no governance plan;
underestimated support load; stars-as-KPI; unpolished self-host docs.

## Sources

See inline links above; additionally: [Actual roadmap 2026](https://actualbudget.org/blog/roadmap-for-2026/),
[Firefly III docs](https://docs.firefly-iii.org/explanation/more-information/what-its-not/),
[Sure fork](https://github.com/we-promise/sure),
[relicensing pattern timeline](https://www.softwareseni.com/the-open-source-license-change-pattern-mongodb-to-redis-timeline-2018-to-2026-and-what-comes-next/),
[FSL](https://fsl.software/), [BSL history](https://fossa.com/blog/business-source-license-requirements-provisions-history/),
[Plausible: open-source SaaS](https://plausible.io/blog/open-source-saas),
[Cal.com EE license](https://github.com/calcom/cal.com/blob/main/packages/features/ee/LICENSE).

**Flagged unverified:** exact Ghostfolio stars; Maybe's precise funding;
Cal.com current ARR; Documenso revenue; traction of 2025–26 small entrants.
