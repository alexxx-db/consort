---
author: Product Owner
---

# StockFlow (product overview)

The Product Owner's standing intent for the warehouse-management
application. It is deliberately open-ended: it says who the product is
for and what they need to accomplish, and the Product Owner refines it
between iterations as working software is seen. It is project-level and
is not a frozen contract. The structured per-feature asks live alongside
it as the Feature Requester's `feature-requests/`; the Spec Author turns
those into the gated `feature-spec` artifacts.

## Who it is for

A mid-market warehouse operation that has outgrown spreadsheets and a
shared Excel file but for whom an enterprise WMS is overpriced and
overwrought. The people in the warehouse who scan goods in, put them on
shelves, pick them off shelves, count them, and ship them. The
inventory manager who reconciles what the system says with what the
shelves actually hold. The operations lead who needs to know whether
today's orders are going to ship.

## What they need to accomplish

- Know what they have, in what quantity, at which physical location, at
  any point in time.
- Receive inbound goods from a supplier and put them somewhere
  recoverable.
- Pick goods off the shelf for a customer order without overcommitting
  what is actually there.
- Count what is on the shelf, and reconcile that count with what the
  system says is there.
- Operate across multiple warehouses without each one needing its own
  copy of the system.

## What I want in V1

The first runnable increment, the V1 that goes into use, should be the
simplest thing that lets the team see and adjust stock at one
warehouse. Concretely:

- File, retrieve, and adjust the stock level of one SKU at one
  location.
- Hold stock for the same SKU at multiple locations within one
  warehouse.
- Record inbound receipts: a known supplier delivers a known quantity,
  and stock goes up at a chosen location.
- Record outbound picks: a customer order draws stock down at a chosen
  location, with the system refusing to overcommit.
- Each unit is identified by a single tracking code that encodes
  location, batch, and serial together. The team is fine with this for
  V1; later iterations will revisit whether those fields should be
  split apart.

Everything beyond V1 is open. The Product Owner expects to revisit and
extend this overview between iterations once V1 is in real use.

## How it is delivered

StockFlow is a modern single-page web application: a React and
TypeScript client the warehouse-floor tablet loads once and navigates
without page reloads, backed by a JSON API. The operator experience
(scan, adjust, and watch the stock row move in place) is a rich
client-side interaction, not a set of server-rendered form-submit
round-trips.

## How I want to work

After each sprint I want to see **working software I can actually use**,
not designs, stubs, or partial scaffolding. Every iteration must land
as something runnable and demonstrable before the next one starts; that
working increment is what I review to decide what the next sprint
should be. A warehouse operator should be able to scan a real barcode
and see the stock level move in real time before I sign off.

## Product-level non-goals

- This is not a production-grade WMS. The features I would expect from
  Manhattan or Blue Yonder (slotting optimization, labor management,
  yard management, advanced forecasting) are out of scope.
- No carrier-rate shopping, no label printing, no shipping integration
  beyond a manual tracking number field.
- No native mobile app. The warehouse operator uses a browser on a
  rugged tablet or a barcode scanner with a browser.
- No accounting integration, no general-ledger postings, no invoicing.
- No multi-tenant isolation across customer companies. One tenant per
  deployment.
- This overview does not say HOW the product is built. The
  non-functional requirements I care about live in `nfrs.md`, the UI
  intent lives in `design-brief.md`, and everything else (technology,
  database schema, layering, services, and endpoints) is the
  Architect's and the implementation's concern.
