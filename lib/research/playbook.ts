import type { SupabaseClient } from "@supabase/supabase-js";

export type CopilotPolicy = {
  task_type: string;
  domain: string;
  policy: {
    min_dwell_threshold?: number;
    strategy?: "skim_headings" | "deep_read" | "auto";
    accept_rate?: number;
    [key: string]: unknown;
  };
};

export type UserPlaybookRule = {
  task_type: string;
  domain: string | null;
  rule_text: string;
  confidence: number;
};

export type LearnedPlaybook = {
  policies: CopilotPolicy[];
  rules: UserPlaybookRule[];
};

export async function getLearnedPlaybook(args: {
  admin: SupabaseClient;
  userId: string;
  taskType?: string; // Optional filter
}): Promise<LearnedPlaybook> {
  const [policyRes, ruleRes] = await Promise.all([
    args.admin
      .schema("deal_intel")
      .from("copilot_policy")
      .select("task_type, domain, policy")
      .eq("user_id", args.userId),
    args.admin
      .schema("deal_intel")
      .from("user_playbook_rule")
      .select("task_type, domain, rule_text, confidence")
      .eq("user_id", args.userId)
  ]);

  let policies = (policyRes.data || []) as CopilotPolicy[];
  let rules = (ruleRes.data || []) as UserPlaybookRule[];

  if (args.taskType) {
    policies = policies.filter(p => p.task_type === args.taskType || p.task_type === "general");
    rules = rules.filter(r => r.task_type === args.taskType || r.task_type === "general");
  }

  return { policies, rules };
}
