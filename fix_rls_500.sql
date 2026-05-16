-- ================================================================
-- FIX: server_members RLS infinite recursion → 500 errors
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ================================================================

-- Step 1: Drop the broken self-referencing policy
DROP POLICY IF EXISTS "Members can view server membership" ON public.server_members;

-- Step 2: Replace with a simple direct-ownership policy (no self-join)
-- Users can always see their OWN membership rows
CREATE POLICY "Users can view own membership"
  ON public.server_members FOR SELECT
  USING (auth.uid() = user_id);

-- Step 3: Also allow members to see ALL members of servers they belong to
-- Using a security-definer function avoids the recursion
CREATE OR REPLACE FUNCTION public.get_my_server_ids()
RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT server_id FROM public.server_members WHERE user_id = auth.uid();
$$;

CREATE POLICY "Members can view co-members"
  ON public.server_members FOR SELECT
  USING (
    server_id IN (SELECT public.get_my_server_ids())
  );

-- ================================================================
-- FIX: invite_code constraint — allow 4-digit codes too
-- The CHECK only allows 6-char codes but generateCode('4') makes 4 digits
-- ================================================================
ALTER TABLE public.servers
  DROP CONSTRAINT IF EXISTS servers_invite_code_check;

ALTER TABLE public.servers
  ADD CONSTRAINT servers_invite_code_check
  CHECK (invite_code ~ '^[A-Z0-9]{4,8}$');

-- ================================================================
-- DONE — reload servers.html and your servers should appear!
-- ================================================================
