-- Fix chat_threads.deal_id foreign key constraint to point to deal_intel.deal instead of public.deals
ALTER TABLE public.chat_threads 
  DROP CONSTRAINT IF EXISTS chat_threads_deal_id_fkey;

-- Ensure there are no orphaned records that don't match the new constraint
UPDATE public.chat_threads 
  SET deal_id = NULL 
  WHERE deal_id IS NOT NULL 
    AND deal_id NOT IN (SELECT id FROM deal_intel.deal);

-- Recreate constraint pointing to deal_intel.deal
ALTER TABLE public.chat_threads 
  ADD CONSTRAINT chat_threads_deal_id_fkey 
  FOREIGN KEY (deal_id) 
  REFERENCES deal_intel.deal(id) 
  ON DELETE SET NULL;
