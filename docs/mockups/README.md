# Design mockups

Static HTML explorations that the built UI was worked out against. Kept because
several of them are still the reference the code cites — `app_premium.js` and
`premium.css` both say things like "matches the approved Command Center mockup's
donut treatment" and "ported verbatim from the user-approved mockups (Command
Center Version E)". Deleting them would strand those comments.

They are reference, not code. Nothing loads them and nothing should.

## Why they are here and not under `public/`

They used to live in `public/js/`, which is served. `_routes.json` excludes
`/js/*` from the Worker so Cloudflare Pages hands those files out as static
assets — which meant every one of these was readable, unauthenticated, on the
production domain:

    https://groundwork-crm.com/js/mockup-financial-hub.html  ->  200
    https://groundwork-crm.com/js/mockup-command-center-e.html -> 200
    https://groundwork-crm.com/js/mockups/index.html         ->  200

The content is placeholder — "Chen Residence", "Kim Residence", a $284,600
annual figure — but a reader outside the company cannot tell placeholder from
real, and revenue numbers on a customer-facing domain do not need to be genuine
to be a problem. `docs/` is not part of the deploy, so moving them fixes the
exposure without losing the reference.

## What was deduplicated on the way

`mockup-command-center.html` existed three times — repo root, `public/`, and
`public/js/` — all byte-identical. `public/js/mockups/` and
`public/static/mockups/` were also identical copies of each other. One canonical
copy of each is kept here; the duplicates are gone.

The root and `public/` copies were never reachable anyway (the Worker owns those
paths and 404s them), so only the `public/js/` set was actually exposed.

## Viewing them

Open the file. They are self-contained HTML with inline styles, apart from
`myday/` which shares `myday/_shared.css`.
