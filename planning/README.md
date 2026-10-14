# Planning

Oct 9, 2026 · @Gabe

Pre-build planning that ties the product docs to an implementable backend contract. Read in this order:

| Doc | What it covers |
| --- | --- |
| [gap-analysis.md](gap-analysis.md) | Loose ends found by cross-checking the architecture doc, the UI brief, and the mockups PDF, each with the decision this plan adopts (`D-n` IDs) |
| [open-questions.md](open-questions.md) | Questions that still need an owner's call (`Q-n` IDs), each with a recommended default so work is not blocked |
| [data-model-changes.md](data-model-changes.md) | Schema deltas against the architecture doc section 6, needed to serve the mockups |
| [chat-service.md](chat-service.md) | Deployment of the streaming chat endpoints on a Lambda Function URL with response streaming |
| [model-providers.md](model-providers.md) | Provider-neutral model interface, per-task routing, fallbacks, local model options, and evals |
| [api/README.md](api/README.md) | Mobile API conventions, auth, chat streaming protocol, and a screen-by-screen data coverage matrix |
| [api/openapi.yaml](api/openapi.yaml) | OpenAPI 3.1 spec for the backend the mobile app integrates with |

Sources reviewed:

- `docs/product/Personal Assistant — Architecture & Approach.md` (cited as **ARCH §n**)
- `docs/product/Personal Assistant — UI Requirements & Design Brief.md` (cited as **BRIEF §n**, screens `S1`–`S10` plus the proposed `S11` Chat history, components `C1`–`C12`)
- `docs/product/Personal Assistant App.pdf` (Oct 9 revision, also available as `Personal Assistant App.html`): 31 mockups, each in light and dark, including the populated Insights screen (p.4) and chat history (p.15, p.57–61). Cited as **PDF p.n** or **p.n**, using the light-mode page number.
- `docs/diagrams/architecture.drawio`

Requirement (`R1`–`R10`) and invariant (`INV-1`–`INV-9`) IDs come from the architecture doc and remain authoritative. Where this folder conflicts with an invariant, the invariant wins; raise it as a question instead.
