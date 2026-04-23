/**
 * Placeholder extractor prompt (format-only). Replace with richer analysis guidance later.
 * Keep this aligned to the user's Layer 1 schema format.
 */

export const PLACEHOLDER_PROMPT_PHASE1_JSON = `You extract startup facts into a strict JSON schema.

Rules:
- Return STRICT JSON ONLY (no markdown, no extra text).
- Match the schema exactly.
- Use null for unknown scalar fields.
- Use [] for unknown/empty arrays.
- Do not infer facts that are not stated.
- Keep text concise and factual (1-3 short sentences for description fields).

SCHEMA:
{
  "notable_company_people": [
    {
      "general_description": "string or null",
      "name": "string or null",
      "company_role": "string or null",
      "education": {
        "general_description": "string or null",
        "institutions": ["string"],
        "majors": ["string"],
        "gpa": "string or null"
      },
      "age": "string or null",
      "location": "string or null",
      "experience": {
        "general_description": "string or null",
        "past_companies_worked_at": ["string"],
        "past_companies_founded_or_previous_exits": ["string"],
        "relevant_achievements": ["string"],
        "research": ["string"],
        "patents": ["string"],
        "projects": ["string"]
      },
      "misc": "string or null"
    }
  ],
  "company_makeup": {
    "general_description": "string or null",
    "general_education_history": "string or null",
    "general_work_background_and_experience": "string or null",
    "company_size_people_count": "string or null"
  },
  "company_origin_story": {
    "general_description_and_founding_team_cohesion_signals": "string or null"
  },
  "company_problem": {
    "general_problem_description": "string or null",
    "customers": {
      "all_potential_customers": ["string"],
      "actual_intended_customers_for_solution": ["string"]
    },
    "urgency": "string or null",
    "current_cost_for_customers": "string or null",
    "tam": "string or null",
    "sam": "string or null",
    "som": "string or null"
  },
  "company_solution": {
    "general_description": "string or null",
    "customers": {
      "who_are_the_customers": ["string"],
      "cost_to_customer_to_buy_product": "string or null",
      "customer_benefit": ["string"]
    },
    "solution_price_for_company": "string or null",
    "price_per_customer_build_and_serve": "string or null",
    "novelty_or_uniqueness": "string or null",
    "distinguishing_factors": ["string"],
    "defensibility": "string or null",
    "patent_ip": ["string"],
    "proprietary_tech_or_solution": ["string"],
    "competitors": [
      {
        "name": "string or null",
        "type_of_company": "string or null",
        "similarity": "string or null",
        "threat_posed": "string or null"
      }
    ],
    "timeline_description": "string or null"
  },
  "company_traction": {
    "revenue_data": "string or null",
    "money_raised_per_stage": ["string"],
    "investor_list": ["string"],
    "notable_partners_or_customers": ["string"],
    "company_stage": "string or null",
    "product_stage": "string or null",
    "customer_size_and_count": "string or null",
    "growth_trends_description": "string or null"
  },
  "negative_aspects": "string or null"
}

Task:
Read the provided source content and output JSON in this schema now.`;
