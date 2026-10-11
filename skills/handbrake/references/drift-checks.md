# Drift checks (`handbrake audit`)

Meta's optimiser is good at the cheapest conversion and silent about quality. These checks catch
the common ways a dashboard looks better while the business gets worse. Every flag is a proposal.
The agent applies none of them on its own.

## What to fetch

Save a JSON array (or `{ "data": [...] }`) of rows. Rows can be ads, ad sets or campaigns; mixed is
fine. Recognised keys (aliases in brackets):

`name` (ad_name, adset_name, campaign_name) · `level` (entity_type) · `spend` (amount_spent, cost) ·
`impressions` · `reach` · `frequency` · `results` (conversions, purchases, leads, actions) ·
`cost_per_result` (cpa, cost_per_purchase, cost_per_lead) · `cpm` · `publisher_platform` (platform) ·
`platform_position` (placement) · `learning_stage` · `advantage_audience` (targeting_automation).

For placement drift, request the insights with a `publisher_platform,platform_position` breakdown.
For cheap-inventory, pass last period's rows with `--previous`.

## Checks

| check | sev | fires when | proposal |
|---|---|---|---|
| placement-drift | high | > 25% of spend on Audience Network, right column, explore home, search, rewarded video, in-stream, marketplace | exclude those placements (an UPDATE the human approves) |
| bleeding | high | a row has 0 results and spend > 3x the average cost per result | PAUSE it (always allowed), say why |
| cheap-inventory | high | with `--previous`: CPM fell > 30% while cost per result did not improve (≥ 95% of before) | check placement breakdown and downstream quality before trusting the numbers |
| fatigue | medium | frequency > 3.5 | new creative or broader audience; no budget raise |
| learning-limited | medium | `learning_stage` contains LEARNING_LIMITED | consolidate ad sets or raise volume before touching budget |
| creative-starvation | low | ≥ 3 ads and the top one takes > 60% of spend | 2 to 3 new variants |
| advantage-audience-on | info | Advantage+ audience expansion is on | confirm the human chose it |

Thresholds are the common practitioner defaults, not laws. Pass `--json` and read `flags[]` if you
want to apply your own.

## What this is not

It does not measure incrementality. A clean audit means these rows did not trip these checks. It
says nothing about whether the conversions were real new customers. For that, propose a holdout
or a conversion lift study; that is a human decision too.
