-- 0054: Client-facing price display mode for estimates
-- price_display: 'itemized' (default — Item/Qty/Total table) |
--                'total_only' (one list price + description-only list of included scope items)
-- The Pricing Workbench and internal detail views always stay fully itemized;
-- this only controls what the CUSTOMER sees on the portal/document.
ALTER TABLE estimates ADD COLUMN price_display TEXT DEFAULT 'itemized';
