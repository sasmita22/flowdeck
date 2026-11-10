# Review flow

Three steps, run in this order.

1. **Plan**, an Agent step: write a short plan for the change.
2. **Review**, an Agent step. Role: reviewer of the repository. It reads `README.md`, lists the
   risks it finds and writes them to `review-notes.md`.
3. **Apply**, an Agent step: read `review-notes.md` and update the plan to address each risk.
