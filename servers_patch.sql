-- ================================================================
-- ZENSPACE — Servers Patch: 4-digit invite codes + RLS fixes
-- Run this in Supabase Dashboard → SQL Editor
-- ================================================================

-- ── FIX 1: Broaden invite_code constraint to accept 4-digit OR 6-char codes ──
-- The old constraint only allowed [A-Z0-9]{6}. We now allow:
--   • 4-digit numeric codes  (e.g. "3847")
--   • 6-char alphanumeric codes  (e.g. "AB3X9Z")
ALTER TABLE public.servers
  DROP CONSTRAINT IF EXISTS servers_invite_code_check;

ALTER TABLE public.servers
  ADD CONSTRAINT servers_invite_code_check
    CHECK (
      invite_code ~ '^[0-9]{4}$'          -- 4-digit numeric
      OR
      invite_code ~ '^[A-Z0-9]{6}$'       -- 6-char alphanumeric (original)
    );

-- ── FIX 2: server_members RLS — drop the self-referencing SELECT policy ──
-- The policy "Members can view server membership" queries server_members
-- from within server_members, causing an infinite-recursion error in Postgres.
-- We replace it with a SECURITY DEFINER function approach.
DROP POLICY IF EXISTS "Members can view server membership" ON public.server_members;

-- Safe helper function that bypasses RLS to check membership
CREATE OR REPLACE FUNCTION public.is_server_member(sid UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.server_members
    WHERE server_id = sid AND user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_server_member(UUID) TO authenticated;

-- Re-create the policy using the safe helper
CREATE POLICY "Members can view server membership"
  ON public.server_members FOR SELECT
  USING (public.is_server_member(server_id));

-- ── FIX 3: server_messages SELECT policy — same recursive guard ──
-- "Server members can read messages" also uses a self-referencing subquery.
DROP POLICY IF EXISTS "Server members can read messages" ON public.server_messages;

CREATE POLICY "Server members can read messages"
  ON public.server_messages FOR SELECT
  USING (public.is_server_member(server_id));

-- ── FIX 4: server_messages INSERT policy ──────────────────────────────────
DROP POLICY IF EXISTS "Server members can send messages" ON public.server_messages;

CREATE POLICY "Server members can send messages"
  ON public.server_messages FOR INSERT
  WITH CHECK (
    auth.uid() = sender_id
    AND public.is_server_member(server_id)
  );

-- ── FIX 5: voice_sessions / voice_signals SELECT policies (from fix_patch) ──
-- These also use a self-referencing subquery — replace with helper.
DROP POLICY IF EXISTS "Server members can view voice sessions" ON public.voice_sessions;
CREATE POLICY "Server members can view voice sessions"
  ON public.voice_sessions FOR SELECT
  USING (public.is_server_member(server_id));

DROP POLICY IF EXISTS "Members can send signals" ON public.voice_signals;
CREATE POLICY "Members can send signals"
  ON public.voice_signals FOR INSERT
  WITH CHECK (
    auth.uid() = from_user
    AND public.is_server_member(server_id)
  );

-- ── DONE ──────────────────────────────────────────────────────────────────
-- After running:
-- 1. Servers page invite button will work correctly.
-- 2. You can now generate 4-digit numeric codes OR 6-char alphanumeric codes.
-- 3. The self-referencing RLS recursion that caused 500 errors is resolved.
