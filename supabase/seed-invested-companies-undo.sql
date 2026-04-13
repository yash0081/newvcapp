-- Undo seed from seed-invested-companies.sql
-- Removes all deals imported with source = invested-companies-md (CASCADE deletes children).
--
-- Run in Supabase SQL Editor after replacing nothing — uses source column only.

BEGIN;

DELETE FROM public.deals
WHERE source = 'invested-companies-md';

COMMIT;

-- Verify: SELECT id, company_name FROM deals WHERE source = 'invested-companies-md';  → 0 rows
