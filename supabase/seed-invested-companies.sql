-- Seed: 10 companies from Invested Companies_.md
-- Populates: deals, deal_analyses, deal_problem (full columns), deal_solution (full), deal_traction (full),
-- deal_metrics, deal_competitors, investors + deal_investors, deal_assumptions, founders (parsed fields).
-- Replace REPLACE_WITH_YOUR_USER_UUID with your auth.users id.

BEGIN;

INSERT INTO public.investors (id, name) VALUES ('32d9d30b-54d5-482d-aba0-f9bf43363bc1'::uuid, '1984 Ventures');
INSERT INTO public.investors (id, name) VALUES ('04108f9c-d99a-45ca-afa7-cd647e6084b7'::uuid, 'Accel');
INSERT INTO public.investors (id, name) VALUES ('ca820f38-929c-43ac-ad26-3a828b8007b9'::uuid, 'Alliance (Web3 Accelerator)');
INSERT INTO public.investors (id, name) VALUES ('c97fbf3b-c031-43aa-a6ef-0967c22864d4'::uuid, 'Andreessen Horowitz (a16z)');
INSERT INTO public.investors (id, name) VALUES ('0dbd595f-e16d-4339-aea4-47f65fad9299'::uuid, 'Booom Ventures');
INSERT INTO public.investors (id, name) VALUES ('3e1ebedd-a8a8-4ea8-ac7f-046715fcb90a'::uuid, 'Cambrian VC');
INSERT INTO public.investors (id, name) VALUES ('05adaee4-568e-4c5e-a7c4-e0f9f8271851'::uuid, 'Castle Island Ventures');
INSERT INTO public.investors (id, name) VALUES ('72b42747-5d07-4fce-a43a-f9de44bcb8b3'::uuid, 'Costanoa Ventures');
INSERT INTO public.investors (id, name) VALUES ('467de086-4238-4195-a113-7cf621abcc72'::uuid, 'Cross River Digital Ventures');
INSERT INTO public.investors (id, name) VALUES ('200a9b43-5e3e-4c05-a1fb-f2be1f532a7f'::uuid, 'DBA');
INSERT INTO public.investors (id, name) VALUES ('4bd0b308-f9fa-43bd-a54a-5c228e247326'::uuid, 'Endeavor Scale Up Ventures');
INSERT INTO public.investors (id, name) VALUES ('33e123f9-e32b-4b1d-ad6c-fca393113ab6'::uuid, 'F4 Fund');
INSERT INTO public.investors (id, name) VALUES ('673bc921-2a7d-41b5-a24a-abca525c3bc3'::uuid, 'Fortune 100 Angel Operators');
INSERT INTO public.investors (id, name) VALUES ('5bd44c84-f823-491e-ac8b-96b1ed7b80a3'::uuid, 'Frontline Ventures');
INSERT INTO public.investors (id, name) VALUES ('3c1d623c-6b9a-4b4f-ac40-2ef216537e4e'::uuid, 'Ignia Partners');
INSERT INTO public.investors (id, name) VALUES ('160241d6-4bf6-404e-a343-41338b294290'::uuid, 'Infinity Ventures');
INSERT INTO public.investors (id, name) VALUES ('0c321da7-d30a-4e03-afef-57164e7e752d'::uuid, 'JPMorganChase');
INSERT INTO public.investors (id, name) VALUES ('324e548d-34cd-4cf5-ac56-1127387c0eb0'::uuid, 'Liquid 2 Ventures');
INSERT INTO public.investors (id, name) VALUES ('d77b9c60-61d8-467c-ad59-5db7eeb2c786'::uuid, 'MVP Ventures');
INSERT INTO public.investors (id, name) VALUES ('4b249372-3cea-48b3-aa40-b05bc44dd073'::uuid, 'Mirana Ventures');
INSERT INTO public.investors (id, name) VALUES ('66a75a72-fa2d-4e9f-ade2-363d8a87d581'::uuid, 'Montage Ventures');
INSERT INTO public.investors (id, name) VALUES ('bfeed6a0-9e47-48d1-a02c-adf58280fa2d'::uuid, 'Nyca Partners');
INSERT INTO public.investors (id, name) VALUES ('8398932a-3caa-4fc7-a0ff-6804476e2670'::uuid, 'Operator Stack');
INSERT INTO public.investors (id, name) VALUES ('2e2872fc-ccaa-4e29-af6b-b7020379fd7b'::uuid, 'Oregon Venture Fund');
INSERT INTO public.investors (id, name) VALUES ('d3d74926-53b5-43ad-ac87-9f6405f9c130'::uuid, 'Point72 Ventures');
INSERT INTO public.investors (id, name) VALUES ('e83c8fc6-4e4c-479c-a241-3dffd7dca87b'::uuid, 'Quiet Capital');
INSERT INTO public.investors (id, name) VALUES ('3801c81c-7405-4e43-acdc-4b1f8b479d96'::uuid, 'Renegade Partners');
INSERT INTO public.investors (id, name) VALUES ('532232d8-1439-44fe-ab8f-6d610655326e'::uuid, 'Ribbit Capital');
INSERT INTO public.investors (id, name) VALUES ('6cf97f50-aaf3-43d7-a7b5-04764ac63e16'::uuid, 'Ripple Impact Investments');
INSERT INTO public.investors (id, name) VALUES ('4f70d331-87dd-4ca1-ae36-b248b98e859b'::uuid, 'SV Angel');
INSERT INTO public.investors (id, name) VALUES ('b6239739-4564-4985-aaa9-206da7fc9fbb'::uuid, 'TTV Capital');
INSERT INTO public.investors (id, name) VALUES ('50246759-8990-4d27-a4a5-1923e2555497'::uuid, 'Third Prime Capital');
INSERT INTO public.investors (id, name) VALUES ('c8ec731e-b43e-4c29-a7dc-6f114fd30736'::uuid, 'Transpose Platform Management');
INSERT INTO public.investors (id, name) VALUES ('2b957e01-a297-40b1-a37a-140bc1c0be96'::uuid, 'Two Sigma Ventures');
INSERT INTO public.investors (id, name) VALUES ('02d4b2c5-7546-40e0-a1da-2d1becae4090'::uuid, 'WillowTree Investments');
INSERT INTO public.investors (id, name) VALUES ('f0e6b46d-4a3e-48f7-a3c4-6bea6496e017'::uuid, 'WillowTree Ventures');
INSERT INTO public.investors (id, name) VALUES ('19593319-34f2-4c71-a45e-d737b3bd202d'::uuid, 'Willowtree Investments');
INSERT INTO public.investors (id, name) VALUES ('6d8c434a-d078-46a9-af0f-a7107f271f90'::uuid, 'Y Combinator');
INSERT INTO public.investors (id, name) VALUES ('9ef4a888-745e-4fb1-a0af-951d2b3f738b'::uuid, 'Y Combinator (Spring 2025 Batch)');
INSERT INTO public.investors (id, name) VALUES ('94b7f3ec-a5db-4f7f-a529-f0c6a8b6f465'::uuid, 'cyber Fund');

INSERT INTO public.deals (id, user_id, company_name, geography, decision, source, pass_reason, pass_reason_detail)
VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  'REPLACE_WITH_YOUR_USER_UUID'::uuid,
  'Alpen Labs',
  'New York, NY',
  'invested',
  'invested-companies-md',
  NULL,
  NULL
);

INSERT INTO public.deal_analyses (id, deal_id, pipeline_version, raw_output)
VALUES (
  '1b000000-0000-4000-8000-000000000001'::uuid,
  '1a000000-0000-4000-8000-000000000001'::uuid,
  2,
  $j${"company_name":"Alpen Labs","founded_year":2022,"headquarters":"New York, NY","founders":[{"name":"Simanta Gautam","role":"Co-founder & CEO","background":"MIT Alumnus; previously at SpaceX and Microsoft."},{"name":"Abishkar Chhetri","role":"Co-founder","background":"MIT Alumnus with a background in complex engineering systems."},{"name":"Liam Eagan","role":"Founding Cryptographer","background":"Former researcher at Blockstream; specialist in zero-knowledge proofs."}],"founding_team":{"approximate_size":30,"key_personnel":[{"name":"John Light","role":"Product","contribution":"Bitcoin scaling researcher and strategist."},{"name":"Trey Del Bonis","role":"Protocol Engineer","contribution":"Core development of the Bitcoin rollup architecture."},{"name":"Manish Bista & Aaron Feickert","role":"Research & Development","contribution":"Key contributors to the 1-of-N verifier for Bitcoin."}]},"traction":{"total_funding":"$19.1 Million","latest_round":"Series B (January 2025)","key_investors":["Ribbit Capital","Castle Island Ventures","DBA","cyber Fund","Mirana Ventures"],"milestones":["Released two public testnets ('Shanghai' and 'Prague') in 2025.","Partnered with Starknet (October 2025) to build a shared verification layer on Bitcoin.","Introduced 'Glock,' a new standard for efficient verification on Bitcoin Script.","Cited by the White House in a 2024 report on blockchain innovation."]},"problem_statement":{"core_concept":"The Bitcoin Meta-Problem","description":"Bitcoin is the most secure asset, but lacks the native infrastructure for complex financial applications.","key_barriers":["Lack of programmability (Bitcoin Script is too limited for DeFi).","Scalability constraints (high fees and low transaction throughput).","Privacy gaps for sensitive institutional or personal transactions.","Reliance on centralized or honest-majority bridges to move BTC."]},"solution":{"primary_product":"Strata","architecture":"A ZK Rollup (Validity Rollup) built on top of Bitcoin.","key_features":["EVM Compatibility: Developers can deploy Ethereum-style smart contracts directly on Bitcoin infrastructure.","Strata Bridge: A trust-minimized, 1-of-N bridge design based on BitVM2 research.","Glock Protocol: A cryptographic standard that enables Ethereum-like verification efficiency on Bitcoin.","Bitcoin Dollar (BTD): A Bitcoin-backed, decentralized stablecoin ecosystem."],"value_proposition":"Allows Bitcoin to function as a programmable financial layer without compromising its core security or decentralization."},"critical_assumptions":[{"assumption_type":"market","assumption_text":"Problem urgency and budget","must_be_true":"Target customers treat \"The Bitcoin Meta-Problem\" as a priority worth paying to solve at venture-scale economics.","failure_mode":"Long sales cycles, churn, or inability to extract ACVs that support the raise.","is_linchpin":true},{"assumption_type":"product","assumption_text":"Differentiation holds","must_be_true":"Strata sustains a durable edge vs incumbents and alternatives (not easily copied in 12–24 months).","failure_mode":"Margin compression or R&D treadmill to stay parity.","is_linchpin":false},{"assumption_type":"execution","assumption_text":"Team velocity through next stage","must_be_true":"The team can hire, sell, and ship through the next funding milestone without losing focus.","failure_mode":"Missed milestones and down-round or flat round.","is_linchpin":false}]}$j$::jsonb
);

INSERT INTO public.deal_problem (
  deal_id, analysis_id,
  problem_statement, root_cause_depth, economic_gravity, structural_urgency,
  persona_clarity, economic_buyer_persona, budget_priority_validation,
  stated_problem_ref, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  '1b000000-0000-4000-8000-000000000001'::uuid,
  'The Bitcoin Meta-Problem

Bitcoin is the most secure asset, but lacks the native infrastructure for complex financial applications.

Barriers:
1. Lack of programmability (Bitcoin Script is too limited for DeFi).
2. Scalability constraints (high fees and low transaction throughput).
3. Privacy gaps for sensitive institutional or personal transactions.
4. Reliance on centralized or honest-majority bridges to move BTC.',
  'Lack of programmability (Bitcoin Script is too limited for DeFi).',
  'Bitcoin is the most secure asset, but lacks the native infrastructure for complex financial applications.',
  '1. Lack of programmability (Bitcoin Script is too limited for DeFi).
2. Scalability constraints (high fees and low transaction throughput).
3. Privacy gaps for sensitive institutional or personal transactions.
4. Reliance on centralized or honest-majority bridges to move BTC.',
  NULL,
  'Economic buyer tied to: The Bitcoin Meta-Problem',
  'Scalability constraints (high fees and low transaction throughput).',
  'The Bitcoin Meta-Problem',
  'historical_seed'
);

INSERT INTO public.deal_solution (
  deal_id, analysis_id,
  solution_summary, product_type, moat_type, replication_difficulty, compounding_potential,
  technical_moat_evidence, differentiation_proof_points, competitor_landscape_json, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  '1b000000-0000-4000-8000-000000000001'::uuid,
  'Strata

A ZK Rollup (Validity Rollup) built on top of Bitcoin.

Allows Bitcoin to function as a programmable financial layer without compromising its core security or decentralization.',
  'Strata',
  'network + integrations',
  'High replication cost: EVM Compatibility: Developers can deploy Ethereum-style smart contracts directly on Bitcoin infrastructure.; Strata Bridge: A trust-minimized, 1-of-N bridge design based on BitVM2 research.',
  'Compounding via: Allows Bitcoin to function as a programmable financial layer without compromising its core security or decentralization.',
  'EVM Compatibility: Developers can deploy Ethereum-style smart contracts directly on Bitcoin infrastructure.
Strata Bridge: A trust-minimized, 1-of-N bridge design based on BitVM2 research.
Glock Protocol: A cryptographic standard that enables Ethereum-like verification efficiency on Bitcoin.
Bitcoin Dollar (BTD): A Bitcoin-backed, decentralized stablecoin ecosystem.',
  $j$["EVM Compatibility: Developers can deploy Ethereum-style smart contracts directly on Bitcoin infrastructure.","Strata Bridge: A trust-minimized, 1-of-N bridge design based on BitVM2 research.","Glock Protocol: A cryptographic standard that enables Ethereum-like verification efficiency on Bitcoin.","Bitcoin Dollar (BTD): A Bitcoin-backed, decentralized stablecoin ecosystem."]$j$::jsonb,
  $j$[{"name":"Meta","category":"incumbent / alternative","note":"Referenced in source narrative"}]$j$::jsonb,
  'historical_seed'
);

INSERT INTO public.deal_traction (
  deal_id, analysis_id,
  traction_evidence_json, phase1_traction_json, milestones_detected,
  inferred_stage, benchmark_context, revenue_data, growth_signals, customer_depth, user_traction,
  notable_partners_and_validation, investor_list, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  '1b000000-0000-4000-8000-000000000001'::uuid,
  $j${"total_funding":"$19.1 Million","latest_round":"Series B (January 2025)","key_investors":["Ribbit Capital","Castle Island Ventures","DBA","cyber Fund","Mirana Ventures"],"milestones":["Released two public testnets ('Shanghai' and 'Prague') in 2025.","Partnered with Starknet (October 2025) to build a shared verification layer on Bitcoin.","Introduced 'Glock,' a new standard for efficient verification on Bitcoin Script.","Cited by the White House in a 2024 report on blockchain innovation."]}$j$::jsonb,
  $j${"total_funding":"$19.1 Million","latest_round":"Series B (January 2025)","key_investors":["Ribbit Capital","Castle Island Ventures","DBA","cyber Fund","Mirana Ventures"],"milestones":["Released two public testnets ('Shanghai' and 'Prague') in 2025.","Partnered with Starknet (October 2025) to build a shared verification layer on Bitcoin.","Introduced 'Glock,' a new standard for efficient verification on Bitcoin Script.","Cited by the White House in a 2024 report on blockchain innovation."]}$j$::jsonb,
  $j$["Released two public testnets ('Shanghai' and 'Prague') in 2025.","Partnered with Starknet (October 2025) to build a shared verification layer on Bitcoin.","Introduced 'Glock,' a new standard for efficient verification on Bitcoin Script.","Cited by the White House in a 2024 report on blockchain innovation."]$j$::jsonb,
  'Founded 2022',
  'HQ: New York, NY | Founded: 2022 | Round: Series B (January 2025)',
  NULL,
  NULL,
  'Partnered with Starknet (October 2025) to build a shared verification layer on Bitcoin.',
  NULL,
  $j$["Released two public testnets ('Shanghai' and 'Prague') in 2025.","Partnered with Starknet (October 2025) to build a shared verification layer on Bitcoin.","Introduced 'Glock,' a new standard for efficient verification on Bitcoin Script.","Cited by the White House in a 2024 report on blockchain innovation."]$j$::jsonb,
  $j$[{"name":"Ribbit Capital","role":"participant"},{"name":"Castle Island Ventures","role":"participant"},{"name":"DBA","role":"participant"},{"name":"cyber Fund","role":"participant"},{"name":"Mirana Ventures","role":"participant"}]$j$::jsonb,
  'historical_seed'
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  'founded_year',
  '2022',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  'headquarters',
  'New York, NY',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  'total_funding',
  '$19.1 Million',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  'latest_round',
  'Series B (January 2025)',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  'traction_highlight_1',
  'Released two public testnets (''Shanghai'' and ''Prague'') in 2025.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  'traction_highlight_2',
  'Partnered with Starknet (October 2025) to build a shared verification layer on Bitcoin.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  'traction_highlight_3',
  'Introduced ''Glock,'' a new standard for efficient verification on Bitcoin Script.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  'traction_highlight_4',
  'Cited by the White House in a 2024 report on blockchain innovation.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  '1b000000-0000-4000-8000-000000000001'::uuid,
  'Meta',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  '532232d8-1439-44fe-ab8f-6d610655326e'::uuid,
  'participant',
  'Series B (January 2025)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  '05adaee4-568e-4c5e-a7c4-e0f9f8271851'::uuid,
  'participant',
  'Series B (January 2025)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  '200a9b43-5e3e-4c05-a1fb-f2be1f532a7f'::uuid,
  'participant',
  'Series B (January 2025)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  '94b7f3ec-a5db-4f7f-a529-f0c6a8b6f465'::uuid,
  'participant',
  'Series B (January 2025)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  '4b249372-3cea-48b3-aa40-b05bc44dd073'::uuid,
  'participant',
  'Series B (January 2025)',
  NULL
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  '1b000000-0000-4000-8000-000000000001'::uuid,
  'Problem urgency and budget',
  'market',
  NULL,
  'Target customers treat "The Bitcoin Meta-Problem" as a priority worth paying to solve at venture-scale economics.',
  true,
  NULL,
  'If the pain is merely ''nice to have'', growth stalls.',
  'Long sales cycles, churn, or inability to extract ACVs that support the raise.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  '1b000000-0000-4000-8000-000000000001'::uuid,
  'Differentiation holds',
  'product',
  NULL,
  'Strata sustains a durable edge vs incumbents and alternatives (not easily copied in 12–24 months).',
  false,
  NULL,
  'Feature gaps or reliability issues erode win rate.',
  'Margin compression or R&D treadmill to stay parity.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  '1b000000-0000-4000-8000-000000000001'::uuid,
  'Team velocity through next stage',
  'execution',
  NULL,
  'The team can hire, sell, and ship through the next funding milestone without losing focus.',
  false,
  NULL,
  'Key-person risk or GTM mis-hires.',
  'Missed milestones and down-round or flat round.'
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  'Simanta Gautam',
  'Co-founder & CEO',
  'MIT Alumnus; previously at SpaceX and Microsoft.',
  ARRAY['MIT']::text[],
  NULL,
  $j$["SpaceX and Microsoft"]$j$::jsonb,
  $j$["MIT","SpaceX and Microsoft"]$j$::jsonb,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Simanta Gautam","role":"Co-founder & CEO","background":"MIT Alumnus; previously at SpaceX and Microsoft."}$j$::jsonb
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  'Abishkar Chhetri',
  'Co-founder',
  'MIT Alumnus with a background in complex engineering systems.',
  ARRAY['MIT']::text[],
  NULL,
  NULL,
  $j$["MIT"]$j$::jsonb,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Abishkar Chhetri","role":"Co-founder","background":"MIT Alumnus with a background in complex engineering systems."}$j$::jsonb
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000001'::uuid,
  'Liam Eagan',
  'Founding Cryptographer',
  'Former researcher at Blockstream; specialist in zero-knowledge proofs.',
  NULL,
  NULL,
  $j$["Blockstream"]$j$::jsonb,
  $j$["Blockstream"]$j$::jsonb,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Liam Eagan","role":"Founding Cryptographer","background":"Former researcher at Blockstream; specialist in zero-knowledge proofs."}$j$::jsonb
);

INSERT INTO public.deals (id, user_id, company_name, geography, decision, source, pass_reason, pass_reason_detail)
VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  'REPLACE_WITH_YOUR_USER_UUID'::uuid,
  'Tensec',
  'Palo Alto & San Francisco, CA',
  'invested',
  'invested-companies-md',
  NULL,
  NULL
);

INSERT INTO public.deal_analyses (id, deal_id, pipeline_version, raw_output)
VALUES (
  '1b000000-0000-4000-8000-000000000002'::uuid,
  '1a000000-0000-4000-8000-000000000002'::uuid,
  2,
  $j${"company_name":"Tensec","founded_year":2023,"headquarters":"Palo Alto & San Francisco, CA","founders":[{"name":"Helcio Nobre","role":"CEO & Co-founder","background":"Former Chief Product Officer at Rapyd; veteran executive from PayPal."},{"name":"Sandrine Cousquer-Okasmaa","role":"COO & Co-founder","background":"Former Head of Compliance at Bond; senior legal/compliance roles at Goldman Sachs, Mastercard, and American Express."},{"name":"Yang Wang","role":"VP Engineering & Co-founder","background":"Former Head of Product Engineering at Bond."}],"founding_team":{"key_expertise":"The team consists of approximately 30 veterans from PayPal, Meta, Goldman Sachs, Visa, Mastercard, and Credit Karma.","specialization":"Deep focus on global compliance, financial infrastructure, and AI-driven growth marketing."},"traction":{"funding":{"total_equity":"$12 Million (Seed Round, June 2025)","debt_facility":"$60 Million (October 2025)","lead_investors":"Costanoa Ventures","participating_investors":["Quiet Capital","WillowTree Investments","Cambrian VC","Ignia Partners","Montage Ventures","Renegade Partners","Endeavor Scale Up Ventures"]},"business_metrics":["Currently managing $10 Billion in annual trade volume for clients.","Projecting growth to $30 Billion annual volume following 2026 expansion into APAC and EU markets.","Operating across 36+ countries with support for 17+ currencies.","Connected to 100+ real-time payment networks."]},"problem_statement":{"core_issue":"Small and Medium-sized Businesses (SMBs) are historically excluded from the sophisticated financial tools used by large enterprises.","barriers":["Legacy Infrastructure: Heavy reliance on 40-year-old SWIFT technology that is slow and opaque.","Complexity: Global trade companies struggle to offer financial services to their partners due to 'Integration Hell.'","Inefficiency: High costs and weeks-long verification processes for international money movement."]},"solution":{"primary_product":"AI-Native Zero-Integration Platform","key_features":["Contextual Finance: Embeds FX, cross-border payments, and transaction banking directly where global traders operate.","Zero-Integration: Allows companies to launch financial services for their clients without heavy engineering overhead.","AI-Driven Compliance: Uses AI agents to cut risk assessment and verification times from weeks to minutes.","Revenue Sharing Model: Enables partners to transform payment facilitation from a cost center into a profitable revenue stream."],"value_proposition":"Modernizing the $190 trillion cross-border market by flipping the banking model—empowering trade companies to act as their own financial hubs for their partners."},"critical_assumptions":[{"assumption_type":"market","assumption_text":"Problem urgency and budget","must_be_true":"Target customers treat \"Small and Medium-sized Businesses (SMBs) are historically excluded from the sophisticated financial tools used by large enterprises.\" as a priority worth paying to solve at venture-scale economics.","failure_mode":"Long sales cycles, churn, or inability to extract ACVs that support the raise.","is_linchpin":true},{"assumption_type":"product","assumption_text":"Differentiation holds","must_be_true":"AI-Native Zero-Integration Platform sustains a durable edge vs incumbents and alternatives (not easily copied in 12–24 months).","failure_mode":"Margin compression or R&D treadmill to stay parity.","is_linchpin":false},{"assumption_type":"execution","assumption_text":"Team velocity through next stage","must_be_true":"The team can hire, sell, and ship through the next funding milestone without losing focus.","failure_mode":"Missed milestones and down-round or flat round.","is_linchpin":false}]}$j$::jsonb
);

INSERT INTO public.deal_problem (
  deal_id, analysis_id,
  problem_statement, root_cause_depth, economic_gravity, structural_urgency,
  persona_clarity, economic_buyer_persona, budget_priority_validation,
  stated_problem_ref, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  '1b000000-0000-4000-8000-000000000002'::uuid,
  'Small and Medium-sized Businesses (SMBs) are historically excluded from the sophisticated financial tools used by large enterprises.

Barriers:
1. Legacy Infrastructure: Heavy reliance on 40-year-old SWIFT technology that is slow and opaque.
2. Complexity: Global trade companies struggle to offer financial services to their partners due to ''Integration Hell.''
3. Inefficiency: High costs and weeks-long verification processes for international money movement.',
  'Legacy Infrastructure: Heavy reliance on 40-year-old SWIFT technology that is slow and opaque.',
  'Economic impact implied by: Legacy Infrastructure: Heavy reliance on 40-year-old SWIFT technology that is slow and opaque. Complexity: Global trade companies struggle to offer financial services to their partners due to ''Integration Hell.''',
  '1. Legacy Infrastructure: Heavy reliance on 40-year-old SWIFT technology that is slow and opaque.
2. Complexity: Global trade companies struggle to offer financial services to their partners due to ''Integration Hell.''
3. Inefficiency: High costs and weeks-long verification processes for international money movement.',
  'SMB / operator buyer',
  'SMB / operator buyer',
  'Inefficiency: High costs and weeks-long verification processes for international money movement.',
  'Small and Medium-sized Businesses (SMBs) are historically excluded from the sophisticated financial tools used by large enterprises.',
  'historical_seed'
);

INSERT INTO public.deal_solution (
  deal_id, analysis_id,
  solution_summary, product_type, moat_type, replication_difficulty, compounding_potential,
  technical_moat_evidence, differentiation_proof_points, competitor_landscape_json, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  '1b000000-0000-4000-8000-000000000002'::uuid,
  'AI-Native Zero-Integration Platform

Modernizing the $190 trillion cross-border market by flipping the banking model—empowering trade companies to act as their own financial hubs for their partners.',
  'AI-Native Zero-Integration Platform',
  'regulatory + workflow',
  'High replication cost: Contextual Finance: Embeds FX, cross-border payments, and transaction banking directly where global traders operate.; Zero-Integration: Allows companies to launch financial services for their clients without heavy engineering overhead.',
  'Compounding via: Modernizing the $190 trillion cross-border market by flipping the banking model—empowering trade companies to act as their own financial hubs for their partners.',
  'Contextual Finance: Embeds FX, cross-border payments, and transaction banking directly where global traders operate.
Zero-Integration: Allows companies to launch financial services for their clients without heavy engineering overhead.
AI-Driven Compliance: Uses AI agents to cut risk assessment and verification times from weeks to minutes.
Revenue Sharing Model: Enables partners to transform payment facilitation from a cost center into a profitable revenue stream.',
  $j$["Contextual Finance: Embeds FX, cross-border payments, and transaction banking directly where global traders operate.","Zero-Integration: Allows companies to launch financial services for their clients without heavy engineering overhead.","AI-Driven Compliance: Uses AI agents to cut risk assessment and verification times from weeks to minutes.","Revenue Sharing Model: Enables partners to transform payment facilitation from a cost center into a profitable revenue stream."]$j$::jsonb,
  $j$[]$j$::jsonb,
  'historical_seed'
);

INSERT INTO public.deal_traction (
  deal_id, analysis_id,
  traction_evidence_json, phase1_traction_json, milestones_detected,
  inferred_stage, benchmark_context, revenue_data, growth_signals, customer_depth, user_traction,
  notable_partners_and_validation, investor_list, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  '1b000000-0000-4000-8000-000000000002'::uuid,
  $j${"funding":{"total_equity":"$12 Million (Seed Round, June 2025)","debt_facility":"$60 Million (October 2025)","lead_investors":"Costanoa Ventures","participating_investors":["Quiet Capital","WillowTree Investments","Cambrian VC","Ignia Partners","Montage Ventures","Renegade Partners","Endeavor Scale Up Ventures"]},"business_metrics":["Currently managing $10 Billion in annual trade volume for clients.","Projecting growth to $30 Billion annual volume following 2026 expansion into APAC and EU markets.","Operating across 36+ countries with support for 17+ currencies.","Connected to 100+ real-time payment networks."]}$j$::jsonb,
  $j${"funding":{"total_equity":"$12 Million (Seed Round, June 2025)","debt_facility":"$60 Million (October 2025)","lead_investors":"Costanoa Ventures","participating_investors":["Quiet Capital","WillowTree Investments","Cambrian VC","Ignia Partners","Montage Ventures","Renegade Partners","Endeavor Scale Up Ventures"]},"business_metrics":["Currently managing $10 Billion in annual trade volume for clients.","Projecting growth to $30 Billion annual volume following 2026 expansion into APAC and EU markets.","Operating across 36+ countries with support for 17+ currencies.","Connected to 100+ real-time payment networks."]}$j$::jsonb,
  $j$["Currently managing $10 Billion in annual trade volume for clients.","Projecting growth to $30 Billion annual volume following 2026 expansion into APAC and EU markets.","Operating across 36+ countries with support for 17+ currencies.","Connected to 100+ real-time payment networks."]$j$::jsonb,
  'Founded 2023',
  'HQ: Palo Alto & San Francisco, CA | Founded: 2023',
  'Currently managing $10 Billion in annual trade volume for clients.
Projecting growth to $30 Billion annual volume following 2026 expansion into APAC and EU markets.',
  'Projecting growth to $30 Billion annual volume following 2026 expansion into APAC and EU markets.',
  NULL,
  'Currently managing $10 Billion in annual trade volume for clients.
Projecting growth to $30 Billion annual volume following 2026 expansion into APAC and EU markets.',
  $j$["Currently managing $10 Billion in annual trade volume for clients.","Projecting growth to $30 Billion annual volume following 2026 expansion into APAC and EU markets.","Operating across 36+ countries with support for 17+ currencies.","Connected to 100+ real-time payment networks."]$j$::jsonb,
  $j$[{"name":"Costanoa Ventures","role":"lead"},{"name":"Quiet Capital","role":"participant"},{"name":"WillowTree Investments","role":"participant"},{"name":"Cambrian VC","role":"participant"},{"name":"Ignia Partners","role":"participant"},{"name":"Montage Ventures","role":"participant"},{"name":"Renegade Partners","role":"participant"},{"name":"Endeavor Scale Up Ventures","role":"participant"}]$j$::jsonb,
  'historical_seed'
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  'founded_year',
  '2023',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  'headquarters',
  'Palo Alto & San Francisco, CA',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  'total_equity',
  '$12 Million (Seed Round, June 2025)',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  'debt_facility',
  '$60 Million (October 2025)',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  'traction_highlight_1',
  'Currently managing $10 Billion in annual trade volume for clients.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  'traction_highlight_2',
  'Projecting growth to $30 Billion annual volume following 2026 expansion into APAC and EU markets.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  'traction_highlight_3',
  'Operating across 36+ countries with support for 17+ currencies.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  'traction_highlight_4',
  'Connected to 100+ real-time payment networks.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  '72b42747-5d07-4fce-a43a-f9de44bcb8b3'::uuid,
  'lead',
  NULL,
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  'e83c8fc6-4e4c-479c-a241-3dffd7dca87b'::uuid,
  'participant',
  NULL,
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  '02d4b2c5-7546-40e0-a1da-2d1becae4090'::uuid,
  'participant',
  NULL,
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  '3e1ebedd-a8a8-4ea8-ac7f-046715fcb90a'::uuid,
  'participant',
  NULL,
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  '3c1d623c-6b9a-4b4f-ac40-2ef216537e4e'::uuid,
  'participant',
  NULL,
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  '66a75a72-fa2d-4e9f-ade2-363d8a87d581'::uuid,
  'participant',
  NULL,
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  '3801c81c-7405-4e43-acdc-4b1f8b479d96'::uuid,
  'participant',
  NULL,
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  '4bd0b308-f9fa-43bd-a54a-5c228e247326'::uuid,
  'participant',
  NULL,
  NULL
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  '1b000000-0000-4000-8000-000000000002'::uuid,
  'Problem urgency and budget',
  'market',
  NULL,
  'Target customers treat "Small and Medium-sized Businesses (SMBs) are historically excluded from the sophisticated financial tools used by large enterprises." as a priority worth paying to solve at venture-scale economics.',
  true,
  NULL,
  'If the pain is merely ''nice to have'', growth stalls.',
  'Long sales cycles, churn, or inability to extract ACVs that support the raise.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  '1b000000-0000-4000-8000-000000000002'::uuid,
  'Differentiation holds',
  'product',
  NULL,
  'AI-Native Zero-Integration Platform sustains a durable edge vs incumbents and alternatives (not easily copied in 12–24 months).',
  false,
  NULL,
  'Feature gaps or reliability issues erode win rate.',
  'Margin compression or R&D treadmill to stay parity.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  '1b000000-0000-4000-8000-000000000002'::uuid,
  'Team velocity through next stage',
  'execution',
  NULL,
  'The team can hire, sell, and ship through the next funding milestone without losing focus.',
  false,
  NULL,
  'Key-person risk or GTM mis-hires.',
  'Missed milestones and down-round or flat round.'
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  'Helcio Nobre',
  'CEO & Co-founder',
  'Former Chief Product Officer at Rapyd; veteran executive from PayPal.',
  NULL,
  NULL,
  $j$["Rapyd"]$j$::jsonb,
  $j$["Rapyd"]$j$::jsonb,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Helcio Nobre","role":"CEO & Co-founder","background":"Former Chief Product Officer at Rapyd; veteran executive from PayPal."}$j$::jsonb
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  'Sandrine Cousquer-Okasmaa',
  'COO & Co-founder',
  'Former Head of Compliance at Bond; senior legal/compliance roles at Goldman Sachs, Mastercard, and American Express.',
  NULL,
  NULL,
  $j$["Bond"]$j$::jsonb,
  $j$["Bond","Goldman Sachs"]$j$::jsonb,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Sandrine Cousquer-Okasmaa","role":"COO & Co-founder","background":"Former Head of Compliance at Bond; senior legal/compliance roles at Goldman Sachs, Mastercard, and American Express."}$j$::jsonb
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000002'::uuid,
  'Yang Wang',
  'VP Engineering & Co-founder',
  'Former Head of Product Engineering at Bond.',
  NULL,
  NULL,
  $j$["Bond"]$j$::jsonb,
  $j$["Bond"]$j$::jsonb,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Yang Wang","role":"VP Engineering & Co-founder","background":"Former Head of Product Engineering at Bond."}$j$::jsonb
);

INSERT INTO public.deals (id, user_id, company_name, geography, decision, source, pass_reason, pass_reason_detail)
VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  'REPLACE_WITH_YOUR_USER_UUID'::uuid,
  'Distributional',
  'San Francisco, CA',
  'invested',
  'invested-companies-md',
  NULL,
  NULL
);

INSERT INTO public.deal_analyses (id, deal_id, pipeline_version, raw_output)
VALUES (
  '1b000000-0000-4000-8000-000000000003'::uuid,
  '1a000000-0000-4000-8000-000000000003'::uuid,
  2,
  $j${"company_name":"Distributional","founded_year":2023,"headquarters":"San Francisco, CA","founders":[{"name":"Scott Clark","role":"Co-founder & CEO","background":"Former VP & GM of AI Software at Intel; Co-founder and CEO of SigOpt (acquired by Intel)."},{"name":"Nick Payton","role":"Co-founder","background":"Former VP of Marketing at SigOpt; background in product and growth for AI platforms."},{"name":"Michael McCourt","role":"Co-founder & CTO","background":"Former Head of Engineering at SigOpt and Senior Staff Research Scientist at Intel."},{"name":"Tobias Andreasen, Renaud Bourassa, Keith Laban","role":"Co-founders","background":"Senior engineering and product leaders with experience from Stripe, Slack, and Uber."}],"founding_team":{"key_expertise":"The founding team consists of 11 veterans from industry giants including Google, Meta, Bloomberg, Intel, and Yelp.","specialization":"Specialists in high-performance computing (HPC), machine learning optimization, and statistical testing."},"traction":{"funding":{"total_funding":"$30 Million","latest_round":"$19 Million Series A (October 2024)","seed_round":"$11 Million (December 2023)","lead_investors":["Two Sigma Ventures","Andreessen Horowitz (a16z)"],"participating_investors":["Operator Stack","Point72 Ventures","SV Angel","Willowtree Investments","Oregon Venture Fund"]},"milestones":["Currently working with over a dozen design partners in finance, energy, and manufacturing.","Launched the industry's first enterprise-grade 'Adaptive Testing' platform in 2024.","Integrated with major MLOps and CI/CD pipelines to automate AI reliability checks."]},"problem_statement":{"core_issue":"AI models are inherently non-deterministic and 'shifty,' making traditional software testing methods (which expect a single correct answer) obsolete.","barriers":["The Confidence Gap: Enterprises are afraid to deploy AI because they cannot predict when or why it will fail.","Vibe Checks: Most teams currently rely on manual, anecdotal testing rather than rigorous statistical data.","Non-Stationarity: AI behavior changes over time due to data drift or upstream model updates without the developer's knowledge."]},"solution":{"primary_product":"The Distributional AI Testing Platform","key_features":["Statistical Outlier Detection: Analyzes distributions of outputs rather than single data points to identify anomalies.","Automated Test Suggestions: Uses AI to recommend the best tests for a specific model's use case.","Adaptive Calibration: Continuously adjusts test thresholds as the model evolves to prevent 'false alarm' fatigue.","CI/CD Integration: Automatically blocks 'unreliable' model versions from being pushed to production."],"value_proposition":"Transforming AI testing from a bottleneck into a scalable, automated process that allows enterprises to ship reliable AI products with the same confidence they have in traditional software."},"critical_assumptions":[{"assumption_type":"market","assumption_text":"Problem urgency and budget","must_be_true":"Target customers treat \"AI models are inherently non-deterministic and 'shifty,' making traditional software testing methods (which expect a single correct answer) obsolete.\" as a priority worth paying to solve at venture-scale economics.","failure_mode":"Long sales cycles, churn, or inability to extract ACVs that support the raise.","is_linchpin":true},{"assumption_type":"product","assumption_text":"Differentiation holds","must_be_true":"The Distributional AI Testing Platform sustains a durable edge vs incumbents and alternatives (not easily copied in 12–24 months).","failure_mode":"Margin compression or R&D treadmill to stay parity.","is_linchpin":false},{"assumption_type":"execution","assumption_text":"Team velocity through next stage","must_be_true":"The team can hire, sell, and ship through the next funding milestone without losing focus.","failure_mode":"Missed milestones and down-round or flat round.","is_linchpin":false}]}$j$::jsonb
);

INSERT INTO public.deal_problem (
  deal_id, analysis_id,
  problem_statement, root_cause_depth, economic_gravity, structural_urgency,
  persona_clarity, economic_buyer_persona, budget_priority_validation,
  stated_problem_ref, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  '1b000000-0000-4000-8000-000000000003'::uuid,
  'AI models are inherently non-deterministic and ''shifty,'' making traditional software testing methods (which expect a single correct answer) obsolete.

Barriers:
1. The Confidence Gap: Enterprises are afraid to deploy AI because they cannot predict when or why it will fail.
2. Vibe Checks: Most teams currently rely on manual, anecdotal testing rather than rigorous statistical data.
3. Non-Stationarity: AI behavior changes over time due to data drift or upstream model updates without the developer''s knowledge.',
  'The Confidence Gap: Enterprises are afraid to deploy AI because they cannot predict when or why it will fail.',
  'Economic impact implied by: The Confidence Gap: Enterprises are afraid to deploy AI because they cannot predict when or why it will fail. Vibe Checks: Most teams currently rely on manual, anecdotal testing rather than rigorous statistical data.',
  '1. The Confidence Gap: Enterprises are afraid to deploy AI because they cannot predict when or why it will fail.
2. Vibe Checks: Most teams currently rely on manual, anecdotal testing rather than rigorous statistical data.
3. Non-Stationarity: AI behavior changes over time due to data drift or upstream model updates without the developer''s knowledge.',
  NULL,
  'Economic buyer tied to: AI models are inherently non-deterministic and ''shifty,'' making traditional software testing methods (which expect a sin',
  NULL,
  'AI models are inherently non-deterministic and ''shifty,'' making traditional software testing methods (which expect a single correct answer) obsolete.',
  'historical_seed'
);

INSERT INTO public.deal_solution (
  deal_id, analysis_id,
  solution_summary, product_type, moat_type, replication_difficulty, compounding_potential,
  technical_moat_evidence, differentiation_proof_points, competitor_landscape_json, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  '1b000000-0000-4000-8000-000000000003'::uuid,
  'The Distributional AI Testing Platform

Transforming AI testing from a bottleneck into a scalable, automated process that allows enterprises to ship reliable AI products with the same confidence they have in traditional software.',
  'The Distributional AI Testing Platform',
  'network + integrations',
  'High replication cost: Statistical Outlier Detection: Analyzes distributions of outputs rather than single data points to identify anomalies.; Automated Test Suggestions: Uses AI to recommend the best tests for a specific model''s use case.',
  'Compounding via: Transforming AI testing from a bottleneck into a scalable, automated process that allows enterprises to ship reliable AI products with the same confidence they have in traditional software.',
  'Statistical Outlier Detection: Analyzes distributions of outputs rather than single data points to identify anomalies.
Automated Test Suggestions: Uses AI to recommend the best tests for a specific model''s use case.
Adaptive Calibration: Continuously adjusts test thresholds as the model evolves to prevent ''false alarm'' fatigue.
CI/CD Integration: Automatically blocks ''unreliable'' model versions from being pushed to production.',
  $j$["Statistical Outlier Detection: Analyzes distributions of outputs rather than single data points to identify anomalies.","Automated Test Suggestions: Uses AI to recommend the best tests for a specific model's use case.","Adaptive Calibration: Continuously adjusts test thresholds as the model evolves to prevent 'false alarm' fatigue.","CI/CD Integration: Automatically blocks 'unreliable' model versions from being pushed to production."]$j$::jsonb,
  $j$[]$j$::jsonb,
  'historical_seed'
);

INSERT INTO public.deal_traction (
  deal_id, analysis_id,
  traction_evidence_json, phase1_traction_json, milestones_detected,
  inferred_stage, benchmark_context, revenue_data, growth_signals, customer_depth, user_traction,
  notable_partners_and_validation, investor_list, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  '1b000000-0000-4000-8000-000000000003'::uuid,
  $j${"funding":{"total_funding":"$30 Million","latest_round":"$19 Million Series A (October 2024)","seed_round":"$11 Million (December 2023)","lead_investors":["Two Sigma Ventures","Andreessen Horowitz (a16z)"],"participating_investors":["Operator Stack","Point72 Ventures","SV Angel","Willowtree Investments","Oregon Venture Fund"]},"milestones":["Currently working with over a dozen design partners in finance, energy, and manufacturing.","Launched the industry's first enterprise-grade 'Adaptive Testing' platform in 2024.","Integrated with major MLOps and CI/CD pipelines to automate AI reliability checks."]}$j$::jsonb,
  $j${"funding":{"total_funding":"$30 Million","latest_round":"$19 Million Series A (October 2024)","seed_round":"$11 Million (December 2023)","lead_investors":["Two Sigma Ventures","Andreessen Horowitz (a16z)"],"participating_investors":["Operator Stack","Point72 Ventures","SV Angel","Willowtree Investments","Oregon Venture Fund"]},"milestones":["Currently working with over a dozen design partners in finance, energy, and manufacturing.","Launched the industry's first enterprise-grade 'Adaptive Testing' platform in 2024.","Integrated with major MLOps and CI/CD pipelines to automate AI reliability checks."]}$j$::jsonb,
  $j$["Currently working with over a dozen design partners in finance, energy, and manufacturing.","Launched the industry's first enterprise-grade 'Adaptive Testing' platform in 2024.","Integrated with major MLOps and CI/CD pipelines to automate AI reliability checks."]$j$::jsonb,
  'Founded 2023',
  'HQ: San Francisco, CA | Founded: 2023 | Round: $19 Million Series A (October 2024)',
  NULL,
  NULL,
  'Currently working with over a dozen design partners in finance, energy, and manufacturing.',
  NULL,
  $j$["Currently working with over a dozen design partners in finance, energy, and manufacturing.","Launched the industry's first enterprise-grade 'Adaptive Testing' platform in 2024.","Integrated with major MLOps and CI/CD pipelines to automate AI reliability checks."]$j$::jsonb,
  $j$[{"name":"Two Sigma Ventures","role":"lead"},{"name":"Andreessen Horowitz (a16z)","role":"lead"},{"name":"Operator Stack","role":"participant"},{"name":"Point72 Ventures","role":"participant"},{"name":"SV Angel","role":"participant"},{"name":"Willowtree Investments","role":"participant"},{"name":"Oregon Venture Fund","role":"participant"}]$j$::jsonb,
  'historical_seed'
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  'founded_year',
  '2023',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  'headquarters',
  'San Francisco, CA',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  'total_funding',
  '$30 Million',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  'latest_round',
  '$19 Million Series A (October 2024)',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  'seed_round',
  '$11 Million (December 2023)',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  'traction_highlight_1',
  'Currently working with over a dozen design partners in finance, energy, and manufacturing.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  'traction_highlight_2',
  'Launched the industry''s first enterprise-grade ''Adaptive Testing'' platform in 2024.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  'traction_highlight_3',
  'Integrated with major MLOps and CI/CD pipelines to automate AI reliability checks.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  '2b957e01-a297-40b1-a37a-140bc1c0be96'::uuid,
  'lead',
  '$19 Million Series A (October 2024)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  'c97fbf3b-c031-43aa-a6ef-0967c22864d4'::uuid,
  'lead',
  '$19 Million Series A (October 2024)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  '8398932a-3caa-4fc7-a0ff-6804476e2670'::uuid,
  'participant',
  '$19 Million Series A (October 2024)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  'd3d74926-53b5-43ad-ac87-9f6405f9c130'::uuid,
  'participant',
  '$19 Million Series A (October 2024)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  '4f70d331-87dd-4ca1-ae36-b248b98e859b'::uuid,
  'participant',
  '$19 Million Series A (October 2024)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  '19593319-34f2-4c71-a45e-d737b3bd202d'::uuid,
  'participant',
  '$19 Million Series A (October 2024)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  '2e2872fc-ccaa-4e29-af6b-b7020379fd7b'::uuid,
  'participant',
  '$19 Million Series A (October 2024)',
  NULL
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  '1b000000-0000-4000-8000-000000000003'::uuid,
  'Problem urgency and budget',
  'market',
  NULL,
  'Target customers treat "AI models are inherently non-deterministic and ''shifty,'' making traditional software testing methods (which expect a single correct answer) obsolete." as a priority worth paying to solve at venture-scale economics.',
  true,
  NULL,
  'If the pain is merely ''nice to have'', growth stalls.',
  'Long sales cycles, churn, or inability to extract ACVs that support the raise.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  '1b000000-0000-4000-8000-000000000003'::uuid,
  'Differentiation holds',
  'product',
  NULL,
  'The Distributional AI Testing Platform sustains a durable edge vs incumbents and alternatives (not easily copied in 12–24 months).',
  false,
  NULL,
  'Feature gaps or reliability issues erode win rate.',
  'Margin compression or R&D treadmill to stay parity.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  '1b000000-0000-4000-8000-000000000003'::uuid,
  'Team velocity through next stage',
  'execution',
  NULL,
  'The team can hire, sell, and ship through the next funding milestone without losing focus.',
  false,
  NULL,
  'Key-person risk or GTM mis-hires.',
  'Missed milestones and down-round or flat round.'
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  'Scott Clark',
  'Co-founder & CEO',
  'Former VP & GM of AI Software at Intel; Co-founder and CEO of SigOpt (acquired by Intel).',
  NULL,
  NULL,
  $j$["Intel"]$j$::jsonb,
  $j$["Intel"]$j$::jsonb,
  NULL,
  $j$["CEO of SigOpt (acquired by Intel)","acquired by Intel)"]$j$::jsonb,
  'invested-companies-md',
  $j${"name":"Scott Clark","role":"Co-founder & CEO","background":"Former VP & GM of AI Software at Intel; Co-founder and CEO of SigOpt (acquired by Intel)."}$j$::jsonb
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  'Nick Payton',
  'Co-founder',
  'Former VP of Marketing at SigOpt; background in product and growth for AI platforms.',
  NULL,
  NULL,
  $j$["SigOpt"]$j$::jsonb,
  $j$["SigOpt"]$j$::jsonb,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Nick Payton","role":"Co-founder","background":"Former VP of Marketing at SigOpt; background in product and growth for AI platforms."}$j$::jsonb
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  'Michael McCourt',
  'Co-founder & CTO',
  'Former Head of Engineering at SigOpt and Senior Staff Research Scientist at Intel.',
  NULL,
  NULL,
  $j$["Intel"]$j$::jsonb,
  $j$["SigOpt and Senior Staff Research Scientist at Intel"]$j$::jsonb,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Michael McCourt","role":"Co-founder & CTO","background":"Former Head of Engineering at SigOpt and Senior Staff Research Scientist at Intel."}$j$::jsonb
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000003'::uuid,
  'Tobias Andreasen, Renaud Bourassa, Keith Laban',
  'Co-founders',
  'Senior engineering and product leaders with experience from Stripe, Slack, and Uber.',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Tobias Andreasen, Renaud Bourassa, Keith Laban","role":"Co-founders","background":"Senior engineering and product leaders with experience from Stripe, Slack, and Uber."}$j$::jsonb
);

INSERT INTO public.deals (id, user_id, company_name, geography, decision, source, pass_reason, pass_reason_detail)
VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  'REPLACE_WITH_YOUR_USER_UUID'::uuid,
  'Fibr AI',
  'San Francisco, CA',
  'invested',
  'invested-companies-md',
  NULL,
  NULL
);

INSERT INTO public.deal_analyses (id, deal_id, pipeline_version, raw_output)
VALUES (
  '1b000000-0000-4000-8000-000000000004'::uuid,
  '1a000000-0000-4000-8000-000000000004'::uuid,
  2,
  $j${"company_name":"Fibr AI","founded_year":2023,"headquarters":"San Francisco, CA","founders":[{"name":"Ankur \"AJ\" Goyal","role":"Co-founder & CEO","background":"Former enterprise software executive with deep experience in growth marketing and AI."},{"name":"Pritam Roy","role":"Co-founder & CPO","background":"Product leader specializing in high-scale enterprise platforms and user experience."}],"founding_team":{"key_expertise":"Comprised of veterans from enterprise software giants and marketing technology sectors.","focus":"Specialists in agentic AI, conversion rate optimization (CRO), and enterprise-grade compliance."},"traction":{"funding":{"total_funding":"$9.3 Million","latest_round":"$7.5 Million Seed (February 2026)","lead_investor":"Accel","participating_investors":["WillowTree Ventures","MVP Ventures","Fortune 100 Angel Operators"]},"business_metrics":["Secured 3-to-5 year contracts with Fortune 50 banks and global healthcare providers.","Reports an average of 28% higher ROI and 30% lower Customer Acquisition Cost (CAC) for early partners.","Successfully processed thousands of concurrent micro-experiments across high-traffic enterprise sites."]},"problem_statement":{"core_issue":"The 'Personalization Gap': While digital ads are hyper-personalized, the websites they lead to remain static and generic.","barriers":["Integration Hell: Traditional CRO tools (like Optimizely or Adobe Target) require heavy engineering and agency support to scale.","Static Destinations: CMS platforms were built to publish content, not to interpret real-time visitor intent or context.","Operational Bottleneck: Manual A/B testing is too slow to keep up with the volume of modern, AI-driven marketing campaigns."]},"solution":{"primary_product":"Agentic Web Experience Layer","key_features":["Intelligent URLs: Every page acts as an autonomous agent that senses intent and reshapes itself in real-time.","Autonomous Experimentation: The platform generates hypotheses and runs parallel tests without manual coding.","Context-Aware Adaptation: Tailors content specifically for visitors coming from LLMs (like ChatGPT), social ads, or search queries.","Human-in-the-Loop Governance: Built-in approval workflows ensure AI-generated variants remain on-brand and compliant for regulated industries."],"value_proposition":"Transforming the website from a passive destination into an active, intelligent part of the growth stack that treats every visitor as an audience of one."},"critical_assumptions":[{"assumption_type":"market","assumption_text":"Problem urgency and budget","must_be_true":"Target customers treat \"The 'Personalization Gap': While digital ads are hyper-personalized, the websites they lead to remain static and generic.\" as a priority worth paying to solve at venture-scale economics.","failure_mode":"Long sales cycles, churn, or inability to extract ACVs that support the raise.","is_linchpin":true},{"assumption_type":"product","assumption_text":"Differentiation holds","must_be_true":"Agentic Web Experience Layer sustains a durable edge vs incumbents and alternatives (not easily copied in 12–24 months).","failure_mode":"Margin compression or R&D treadmill to stay parity.","is_linchpin":false},{"assumption_type":"execution","assumption_text":"Team velocity through next stage","must_be_true":"The team can hire, sell, and ship through the next funding milestone without losing focus.","failure_mode":"Missed milestones and down-round or flat round.","is_linchpin":false}]}$j$::jsonb
);

INSERT INTO public.deal_problem (
  deal_id, analysis_id,
  problem_statement, root_cause_depth, economic_gravity, structural_urgency,
  persona_clarity, economic_buyer_persona, budget_priority_validation,
  stated_problem_ref, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  '1b000000-0000-4000-8000-000000000004'::uuid,
  'The ''Personalization Gap'': While digital ads are hyper-personalized, the websites they lead to remain static and generic.

Barriers:
1. Integration Hell: Traditional CRO tools (like Optimizely or Adobe Target) require heavy engineering and agency support to scale.
2. Static Destinations: CMS platforms were built to publish content, not to interpret real-time visitor intent or context.
3. Operational Bottleneck: Manual A/B testing is too slow to keep up with the volume of modern, AI-driven marketing campaigns.',
  'Integration Hell: Traditional CRO tools (like Optimizely or Adobe Target) require heavy engineering and agency support to scale.',
  'Economic impact implied by: Integration Hell: Traditional CRO tools (like Optimizely or Adobe Target) require heavy engineering and agency support to scale. Static Destinations: CMS platforms were built to publish content, not to interpret real-time visitor intent or context.',
  '1. Integration Hell: Traditional CRO tools (like Optimizely or Adobe Target) require heavy engineering and agency support to scale.
2. Static Destinations: CMS platforms were built to publish content, not to interpret real-time visitor intent or context.
3. Operational Bottleneck: Manual A/B testing is too slow to keep up with the volume of modern, AI-driven marketing campaigns.',
  NULL,
  'Economic buyer tied to: The ''Personalization Gap'': While digital ads are hyper-personalized, the websites they lead to remain static and generic',
  NULL,
  'The ''Personalization Gap'': While digital ads are hyper-personalized, the websites they lead to remain static and generic.',
  'historical_seed'
);

INSERT INTO public.deal_solution (
  deal_id, analysis_id,
  solution_summary, product_type, moat_type, replication_difficulty, compounding_potential,
  technical_moat_evidence, differentiation_proof_points, competitor_landscape_json, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  '1b000000-0000-4000-8000-000000000004'::uuid,
  'Agentic Web Experience Layer

Transforming the website from a passive destination into an active, intelligent part of the growth stack that treats every visitor as an audience of one.',
  'Agentic Web Experience Layer',
  'regulatory + workflow',
  'High replication cost: Intelligent URLs: Every page acts as an autonomous agent that senses intent and reshapes itself in real-time.; Autonomous Experimentation: The platform generates hypotheses and runs parallel tests without manual coding.',
  'Compounding via: Transforming the website from a passive destination into an active, intelligent part of the growth stack that treats every visitor as an audience of one.',
  'Intelligent URLs: Every page acts as an autonomous agent that senses intent and reshapes itself in real-time.
Autonomous Experimentation: The platform generates hypotheses and runs parallel tests without manual coding.
Context-Aware Adaptation: Tailors content specifically for visitors coming from LLMs (like ChatGPT), social ads, or search queries.
Human-in-the-Loop Governance: Built-in approval workflows ensure AI-generated variants remain on-brand and compliant for regulated industries.',
  $j$["Intelligent URLs: Every page acts as an autonomous agent that senses intent and reshapes itself in real-time.","Autonomous Experimentation: The platform generates hypotheses and runs parallel tests without manual coding.","Context-Aware Adaptation: Tailors content specifically for visitors coming from LLMs (like ChatGPT), social ads, or search queries.","Human-in-the-Loop Governance: Built-in approval workflows ensure AI-generated variants remain on-brand and compliant for regulated industries."]$j$::jsonb,
  $j$[]$j$::jsonb,
  'historical_seed'
);

INSERT INTO public.deal_traction (
  deal_id, analysis_id,
  traction_evidence_json, phase1_traction_json, milestones_detected,
  inferred_stage, benchmark_context, revenue_data, growth_signals, customer_depth, user_traction,
  notable_partners_and_validation, investor_list, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  '1b000000-0000-4000-8000-000000000004'::uuid,
  $j${"funding":{"total_funding":"$9.3 Million","latest_round":"$7.5 Million Seed (February 2026)","lead_investor":"Accel","participating_investors":["WillowTree Ventures","MVP Ventures","Fortune 100 Angel Operators"]},"business_metrics":["Secured 3-to-5 year contracts with Fortune 50 banks and global healthcare providers.","Reports an average of 28% higher ROI and 30% lower Customer Acquisition Cost (CAC) for early partners.","Successfully processed thousands of concurrent micro-experiments across high-traffic enterprise sites."]}$j$::jsonb,
  $j${"funding":{"total_funding":"$9.3 Million","latest_round":"$7.5 Million Seed (February 2026)","lead_investor":"Accel","participating_investors":["WillowTree Ventures","MVP Ventures","Fortune 100 Angel Operators"]},"business_metrics":["Secured 3-to-5 year contracts with Fortune 50 banks and global healthcare providers.","Reports an average of 28% higher ROI and 30% lower Customer Acquisition Cost (CAC) for early partners.","Successfully processed thousands of concurrent micro-experiments across high-traffic enterprise sites."]}$j$::jsonb,
  $j$["Secured 3-to-5 year contracts with Fortune 50 banks and global healthcare providers.","Reports an average of 28% higher ROI and 30% lower Customer Acquisition Cost (CAC) for early partners.","Successfully processed thousands of concurrent micro-experiments across high-traffic enterprise sites."]$j$::jsonb,
  'Founded 2023',
  'HQ: San Francisco, CA | Founded: 2023 | Round: $7.5 Million Seed (February 2026)',
  'Secured 3-to-5 year contracts with Fortune 50 banks and global healthcare providers.',
  NULL,
  'Secured 3-to-5 year contracts with Fortune 50 banks and global healthcare providers.
Reports an average of 28% higher ROI and 30% lower Customer Acquisition Cost (CAC) for early partners.',
  'Secured 3-to-5 year contracts with Fortune 50 banks and global healthcare providers.',
  $j$["Secured 3-to-5 year contracts with Fortune 50 banks and global healthcare providers.","Reports an average of 28% higher ROI and 30% lower Customer Acquisition Cost (CAC) for early partners.","Successfully processed thousands of concurrent micro-experiments across high-traffic enterprise sites."]$j$::jsonb,
  $j$[{"name":"Accel","role":"lead"},{"name":"WillowTree Ventures","role":"participant"},{"name":"MVP Ventures","role":"participant"},{"name":"Fortune 100 Angel Operators","role":"participant"}]$j$::jsonb,
  'historical_seed'
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  'founded_year',
  '2023',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  'headquarters',
  'San Francisco, CA',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  'total_funding',
  '$9.3 Million',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  'latest_round',
  '$7.5 Million Seed (February 2026)',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  'traction_highlight_1',
  'Secured 3-to-5 year contracts with Fortune 50 banks and global healthcare providers.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  'traction_highlight_2',
  'Reports an average of 28% higher ROI and 30% lower Customer Acquisition Cost (CAC) for early partners.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  'traction_highlight_3',
  'Successfully processed thousands of concurrent micro-experiments across high-traffic enterprise sites.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  '04108f9c-d99a-45ca-afa7-cd647e6084b7'::uuid,
  'lead',
  '$7.5 Million Seed (February 2026)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  'f0e6b46d-4a3e-48f7-a3c4-6bea6496e017'::uuid,
  'participant',
  '$7.5 Million Seed (February 2026)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  'd77b9c60-61d8-467c-ad59-5db7eeb2c786'::uuid,
  'participant',
  '$7.5 Million Seed (February 2026)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  '673bc921-2a7d-41b5-a24a-abca525c3bc3'::uuid,
  'participant',
  '$7.5 Million Seed (February 2026)',
  NULL
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  '1b000000-0000-4000-8000-000000000004'::uuid,
  'Problem urgency and budget',
  'market',
  NULL,
  'Target customers treat "The ''Personalization Gap'': While digital ads are hyper-personalized, the websites they lead to remain static and generic." as a priority worth paying to solve at venture-scale economics.',
  true,
  NULL,
  'If the pain is merely ''nice to have'', growth stalls.',
  'Long sales cycles, churn, or inability to extract ACVs that support the raise.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  '1b000000-0000-4000-8000-000000000004'::uuid,
  'Differentiation holds',
  'product',
  NULL,
  'Agentic Web Experience Layer sustains a durable edge vs incumbents and alternatives (not easily copied in 12–24 months).',
  false,
  NULL,
  'Feature gaps or reliability issues erode win rate.',
  'Margin compression or R&D treadmill to stay parity.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  '1b000000-0000-4000-8000-000000000004'::uuid,
  'Team velocity through next stage',
  'execution',
  NULL,
  'The team can hire, sell, and ship through the next funding milestone without losing focus.',
  false,
  NULL,
  'Key-person risk or GTM mis-hires.',
  'Missed milestones and down-round or flat round.'
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  'Ankur "AJ" Goyal',
  'Co-founder & CEO',
  'Former enterprise software executive with deep experience in growth marketing and AI.',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Ankur \"AJ\" Goyal","role":"Co-founder & CEO","background":"Former enterprise software executive with deep experience in growth marketing and AI."}$j$::jsonb
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000004'::uuid,
  'Pritam Roy',
  'Co-founder & CPO',
  'Product leader specializing in high-scale enterprise platforms and user experience.',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Pritam Roy","role":"Co-founder & CPO","background":"Product leader specializing in high-scale enterprise platforms and user experience."}$j$::jsonb
);

INSERT INTO public.deals (id, user_id, company_name, geography, decision, source, pass_reason, pass_reason_detail)
VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  'REPLACE_WITH_YOUR_USER_UUID'::uuid,
  'FairPlay AI',
  'Los Angeles, CA',
  'invested',
  'invested-companies-md',
  NULL,
  NULL
);

INSERT INTO public.deal_analyses (id, deal_id, pipeline_version, raw_output)
VALUES (
  '1b000000-0000-4000-8000-000000000005'::uuid,
  '1a000000-0000-4000-8000-000000000005'::uuid,
  2,
  $j${"company_name":"FairPlay AI","founded_year":2020,"headquarters":"Los Angeles, CA","founders":[{"name":"Kareem Saleh","role":"Founder & CEO","background":"Former executive at Zest.ai and SoftCard; served in the Obama Administration managing international investment teams."},{"name":"John Merrill","role":"Co-founder & Principal Scientist","background":"Mathematician and AI expert; previously a lead scientist at Zest.ai and spent 15 years at Microsoft and Google building ML tools."}],"founding_team":{"key_personnel":[{"name":"Patrick Cadic","role":"COO","background":"Experienced operations leader in fintech and high-growth startups."},{"name":"Abby Hogan","role":"SVP of Legal Affairs","background":"Specialist in regulatory compliance and fair lending law."},{"name":"Mark Eberstein","role":"EVP of Data Science","background":"Expert in algorithmic fairness and statistical modeling."}],"team_composition":"The team includes veterans from Microsoft, Google, PayPal, and Goldman Sachs, specializing in AI safety, regulatory law, and consumer finance."},"traction":{"funding":{"total_funding":"$24.5 Million","latest_round":"$10 Million (February 2025)","lead_investors":"Infinity Ventures","participating_investors":["JPMorganChase","Nyca Partners","Cross River Digital Ventures","TTV Capital","Third Prime Capital"]},"milestones":["Reported a 3x increase in revenue and client base throughout 2024.","Established multi-year partnerships with major financial institutions including Chime, Upgrade, Pathward, and Varo Bank.","Integrated with risk platforms like Oscilar to provide embedded fairness tools to their customer networks.","Currently serves over 25 banks and fintechs, managing fairness for billions in loan volume."]},"problem_statement":{"core_issue":"The 'Black Box' Bias Problem: As banks move to AI-driven underwriting, they risk inheriting historical biases that lead to unfair rejection of protected classes.","barriers":["Regulatory Pressure: Agencies like the CFPB and regulators under SR 11-7 require AI models to be transparent, explainable, and fair.","Manual Inefficiency: Traditional fair-lending audits take months and are based on 'batch' data rather than real-time monitoring.","The 'Second Look' Gap: Lenders often lack an automated way to re-evaluate 'near-miss' applicants who are creditworthy but flagged by biased algorithms."]},"solution":{"primary_product":"Fairness-as-a-Service™ Platform","key_features":["Automated Bias Testing: APIs that back-test and monitor models in real-time to identify disparate impacts on protected groups.","Second-Look Underwriting: An automated system that re-underwrites declined applications to find creditworthy borrowers the primary model missed.","SR 11-7 Compliance: Auto-generates regulatory-ready documentation, cutting validation cycles from months to days.","Agentic AI Validation: Independent evaluation tools for AI agents to ensure they remain safe and compliant in financial environments.","Fairness Optimization: Proprietary 'loss functions' that teach models to maximize approvals while minimizing disparity during the training phase."],"value_proposition":"Enabling financial institutions to increase approval rates (typically 10-20%) and revenue without increasing risk, all while maintaining perfect regulatory compliance."},"critical_assumptions":[{"assumption_type":"market","assumption_text":"Problem urgency and budget","must_be_true":"Target customers treat \"The 'Black Box' Bias Problem: As banks move to AI-driven underwriting, they risk inheriting historical biases that lead to unfair rejection of protected classes.\" as a priority worth paying to solve at venture-scale economics.","failure_mode":"Long sales cycles, churn, or inability to extract ACVs that support the raise.","is_linchpin":true},{"assumption_type":"product","assumption_text":"Differentiation holds","must_be_true":"Fairness-as-a-Service™ Platform sustains a durable edge vs incumbents and alternatives (not easily copied in 12–24 months).","failure_mode":"Margin compression or R&D treadmill to stay parity.","is_linchpin":false},{"assumption_type":"execution","assumption_text":"Team velocity through next stage","must_be_true":"The team can hire, sell, and ship through the next funding milestone without losing focus.","failure_mode":"Missed milestones and down-round or flat round.","is_linchpin":false}]}$j$::jsonb
);

INSERT INTO public.deal_problem (
  deal_id, analysis_id,
  problem_statement, root_cause_depth, economic_gravity, structural_urgency,
  persona_clarity, economic_buyer_persona, budget_priority_validation,
  stated_problem_ref, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  '1b000000-0000-4000-8000-000000000005'::uuid,
  'The ''Black Box'' Bias Problem: As banks move to AI-driven underwriting, they risk inheriting historical biases that lead to unfair rejection of protected classes.

Barriers:
1. Regulatory Pressure: Agencies like the CFPB and regulators under SR 11-7 require AI models to be transparent, explainable, and fair.
2. Manual Inefficiency: Traditional fair-lending audits take months and are based on ''batch'' data rather than real-time monitoring.
3. The ''Second Look'' Gap: Lenders often lack an automated way to re-evaluate ''near-miss'' applicants who are creditworthy but flagged by biased algorithms.',
  'Regulatory Pressure: Agencies like the CFPB and regulators under SR 11-7 require AI models to be transparent, explainable, and fair.',
  'Economic impact implied by: Regulatory Pressure: Agencies like the CFPB and regulators under SR 11-7 require AI models to be transparent, explainable, and fair. Manual Inefficiency: Traditional fair-lending audits take months and are based on ''batch'' data rather than real-time monitoring.',
  '1. Regulatory Pressure: Agencies like the CFPB and regulators under SR 11-7 require AI models to be transparent, explainable, and fair.
2. Manual Inefficiency: Traditional fair-lending audits take months and are based on ''batch'' data rather than real-time monitoring.
3. The ''Second Look'' Gap: Lenders often lack an automated way to re-evaluate ''near-miss'' applicants who are creditworthy but flagged by biased algorithms.',
  'Enterprise / regulated financial buyer',
  'Enterprise / regulated financial buyer',
  NULL,
  'The ''Black Box'' Bias Problem: As banks move to AI-driven underwriting, they risk inheriting historical biases that lead to unfair rejection of protected classes.',
  'historical_seed'
);

INSERT INTO public.deal_solution (
  deal_id, analysis_id,
  solution_summary, product_type, moat_type, replication_difficulty, compounding_potential,
  technical_moat_evidence, differentiation_proof_points, competitor_landscape_json, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  '1b000000-0000-4000-8000-000000000005'::uuid,
  'Fairness-as-a-Service™ Platform

Enabling financial institutions to increase approval rates (typically 10-20%) and revenue without increasing risk, all while maintaining perfect regulatory compliance.',
  'Fairness-as-a-Service™ Platform',
  'regulatory + workflow',
  'High replication cost: Automated Bias Testing: APIs that back-test and monitor models in real-time to identify disparate impacts on protected groups.; Second-Look Underwriting: An automated system that re-underwrites declined applications to find creditworthy borrowers the primary model missed.',
  'Compounding via: Enabling financial institutions to increase approval rates (typically 10-20%) and revenue without increasing risk, all while maintaining perfect regulatory compliance.',
  'Automated Bias Testing: APIs that back-test and monitor models in real-time to identify disparate impacts on protected groups.
Second-Look Underwriting: An automated system that re-underwrites declined applications to find creditworthy borrowers the primary model missed.
SR 11-7 Compliance: Auto-generates regulatory-ready documentation, cutting validation cycles from months to days.
Agentic AI Validation: Independent evaluation tools for AI agents to ensure they remain safe and compliant in financial environments.',
  $j$["Automated Bias Testing: APIs that back-test and monitor models in real-time to identify disparate impacts on protected groups.","Second-Look Underwriting: An automated system that re-underwrites declined applications to find creditworthy borrowers the primary model missed.","SR 11-7 Compliance: Auto-generates regulatory-ready documentation, cutting validation cycles from months to days.","Agentic AI Validation: Independent evaluation tools for AI agents to ensure they remain safe and compliant in financial environments.","Fairness Optimization: Proprietary 'loss functions' that teach models to maximize approvals while minimizing disparity during the training phase."]$j$::jsonb,
  $j$[]$j$::jsonb,
  'historical_seed'
);

INSERT INTO public.deal_traction (
  deal_id, analysis_id,
  traction_evidence_json, phase1_traction_json, milestones_detected,
  inferred_stage, benchmark_context, revenue_data, growth_signals, customer_depth, user_traction,
  notable_partners_and_validation, investor_list, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  '1b000000-0000-4000-8000-000000000005'::uuid,
  $j${"funding":{"total_funding":"$24.5 Million","latest_round":"$10 Million (February 2025)","lead_investors":"Infinity Ventures","participating_investors":["JPMorganChase","Nyca Partners","Cross River Digital Ventures","TTV Capital","Third Prime Capital"]},"milestones":["Reported a 3x increase in revenue and client base throughout 2024.","Established multi-year partnerships with major financial institutions including Chime, Upgrade, Pathward, and Varo Bank.","Integrated with risk platforms like Oscilar to provide embedded fairness tools to their customer networks.","Currently serves over 25 banks and fintechs, managing fairness for billions in loan volume."]}$j$::jsonb,
  $j${"funding":{"total_funding":"$24.5 Million","latest_round":"$10 Million (February 2025)","lead_investors":"Infinity Ventures","participating_investors":["JPMorganChase","Nyca Partners","Cross River Digital Ventures","TTV Capital","Third Prime Capital"]},"milestones":["Reported a 3x increase in revenue and client base throughout 2024.","Established multi-year partnerships with major financial institutions including Chime, Upgrade, Pathward, and Varo Bank.","Integrated with risk platforms like Oscilar to provide embedded fairness tools to their customer networks.","Currently serves over 25 banks and fintechs, managing fairness for billions in loan volume."]}$j$::jsonb,
  $j$["Reported a 3x increase in revenue and client base throughout 2024.","Established multi-year partnerships with major financial institutions including Chime, Upgrade, Pathward, and Varo Bank.","Integrated with risk platforms like Oscilar to provide embedded fairness tools to their customer networks.","Currently serves over 25 banks and fintechs, managing fairness for billions in loan volume."]$j$::jsonb,
  'Founded 2020',
  'HQ: Los Angeles, CA | Founded: 2020 | Round: $10 Million (February 2025)',
  'Reported a 3x increase in revenue and client base throughout 2024.
Currently serves over 25 banks and fintechs, managing fairness for billions in loan volume.',
  'Reported a 3x increase in revenue and client base throughout 2024.',
  'Established multi-year partnerships with major financial institutions including Chime, Upgrade, Pathward, and Varo Bank.
Integrated with risk platforms like Oscilar to provide embedded fairness tools to their customer networks.
Currently serves over 25 banks and fintechs, managing fairness for billions in loan volume.',
  'Currently serves over 25 banks and fintechs, managing fairness for billions in loan volume.',
  $j$["Reported a 3x increase in revenue and client base throughout 2024.","Established multi-year partnerships with major financial institutions including Chime, Upgrade, Pathward, and Varo Bank.","Integrated with risk platforms like Oscilar to provide embedded fairness tools to their customer networks.","Currently serves over 25 banks and fintechs, managing fairness for billions in loan volume."]$j$::jsonb,
  $j$[{"name":"Infinity Ventures","role":"lead"},{"name":"JPMorganChase","role":"participant"},{"name":"Nyca Partners","role":"participant"},{"name":"Cross River Digital Ventures","role":"participant"},{"name":"TTV Capital","role":"participant"},{"name":"Third Prime Capital","role":"participant"}]$j$::jsonb,
  'historical_seed'
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  'founded_year',
  '2020',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  'headquarters',
  'Los Angeles, CA',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  'total_funding',
  '$24.5 Million',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  'latest_round',
  '$10 Million (February 2025)',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  'traction_highlight_1',
  'Reported a 3x increase in revenue and client base throughout 2024.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  'traction_highlight_2',
  'Established multi-year partnerships with major financial institutions including Chime, Upgrade, Pathward, and Varo Bank.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  'traction_highlight_3',
  'Integrated with risk platforms like Oscilar to provide embedded fairness tools to their customer networks.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  'traction_highlight_4',
  'Currently serves over 25 banks and fintechs, managing fairness for billions in loan volume.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  '160241d6-4bf6-404e-a343-41338b294290'::uuid,
  'lead',
  '$10 Million (February 2025)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  '0c321da7-d30a-4e03-afef-57164e7e752d'::uuid,
  'participant',
  '$10 Million (February 2025)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  'bfeed6a0-9e47-48d1-a02c-adf58280fa2d'::uuid,
  'participant',
  '$10 Million (February 2025)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  '467de086-4238-4195-a113-7cf621abcc72'::uuid,
  'participant',
  '$10 Million (February 2025)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  'b6239739-4564-4985-aaa9-206da7fc9fbb'::uuid,
  'participant',
  '$10 Million (February 2025)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  '50246759-8990-4d27-a4a5-1923e2555497'::uuid,
  'participant',
  '$10 Million (February 2025)',
  NULL
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  '1b000000-0000-4000-8000-000000000005'::uuid,
  'Problem urgency and budget',
  'market',
  NULL,
  'Target customers treat "The ''Black Box'' Bias Problem: As banks move to AI-driven underwriting, they risk inheriting historical biases that lead to unfair rejection of protected classes." as a priority worth paying to solve at venture-scale economics.',
  true,
  NULL,
  'If the pain is merely ''nice to have'', growth stalls.',
  'Long sales cycles, churn, or inability to extract ACVs that support the raise.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  '1b000000-0000-4000-8000-000000000005'::uuid,
  'Differentiation holds',
  'product',
  NULL,
  'Fairness-as-a-Service™ Platform sustains a durable edge vs incumbents and alternatives (not easily copied in 12–24 months).',
  false,
  NULL,
  'Feature gaps or reliability issues erode win rate.',
  'Margin compression or R&D treadmill to stay parity.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  '1b000000-0000-4000-8000-000000000005'::uuid,
  'Team velocity through next stage',
  'execution',
  NULL,
  'The team can hire, sell, and ship through the next funding milestone without losing focus.',
  false,
  NULL,
  'Key-person risk or GTM mis-hires.',
  'Missed milestones and down-round or flat round.'
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  'Kareem Saleh',
  'Founder & CEO',
  'Former executive at Zest.ai and SoftCard; served in the Obama Administration managing international investment teams.',
  NULL,
  NULL,
  $j$["Zest"]$j$::jsonb,
  $j$["Zest"]$j$::jsonb,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Kareem Saleh","role":"Founder & CEO","background":"Former executive at Zest.ai and SoftCard; served in the Obama Administration managing international investment teams."}$j$::jsonb
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000005'::uuid,
  'John Merrill',
  'Co-founder & Principal Scientist',
  'Mathematician and AI expert; previously a lead scientist at Zest.ai and spent 15 years at Microsoft and Google building ML tools.',
  NULL,
  NULL,
  $j$["a lead scientist at Zest"]$j$::jsonb,
  $j$["Zest","Microsoft and Google building ML tools"]$j$::jsonb,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"John Merrill","role":"Co-founder & Principal Scientist","background":"Mathematician and AI expert; previously a lead scientist at Zest.ai and spent 15 years at Microsoft and Google building ML tools."}$j$::jsonb
);

INSERT INTO public.deals (id, user_id, company_name, geography, decision, source, pass_reason, pass_reason_detail)
VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  'REPLACE_WITH_YOUR_USER_UUID'::uuid,
  'Valence (valence.trade)',
  'New York, NY',
  'passed',
  'invested-companies-md',
  'hypothetical_rejection',
  '{"market_concentration_risk":"The ''Duopoly'' Problem: Unlike the crypto exchange market (which has dozens of liquid venues), prediction markets in 2026 are heavily dominated by just two players: Polymarket (global) and Kalshi (U.S.). In a ''winner-takes-all'' or ''winner-takes-most'' scenario, the value of an aggregator is significantly diminished because traders don''t need to ''aggregate'' if 95% of the volume is on one platform.","platform_dependency":"Valence is entirely dependent on the goodwill of the underlying exchanges. If Kalshi or Polymarket decide to restrict API access or launch their own professional terminals, Valence’s core product could be rendered obsolete overnight (the ''Sherlocking'' risk).","TAM_limitations":"While the total volume of prediction markets is growing, the subset of ''systematic/algo traders'' who need a professional terminal is still relatively small. We are skeptical that the ''pro-trader'' segment alone provides a large enough Total Addressable Market (TAM) to justify a venture-scale return.","Regulatory_Complexity":"Managing a unified interface that bridges CFTC-regulated U.S. exchanges (Kalshi) and offshore crypto-native platforms (Polymarket) creates a massive legal and compliance headache. The risk of being classified as an unregistered broker-dealer is a significant tail risk that we aren''t comfortable with at this stage.","Execution_vs_Moat":"The product is impressive, but the ''moat'' (defensibility) is low. Other well-funded trading platforms (like FalconX or even Interactive Brokers) could integrate these features as a minor update to their existing infrastructure once the market reaches sufficient maturity."}'
);

INSERT INTO public.deal_analyses (id, deal_id, pipeline_version, raw_output)
VALUES (
  '1b000000-0000-4000-8000-000000000006'::uuid,
  '1a000000-0000-4000-8000-000000000006'::uuid,
  2,
  $j${"company_name":"Valence (valence.trade)","founded_year":2025,"headquarters":"New York, NY","founders":[{"name":"Neo Wang","role":"Co-founder","background":"Quantitative trader and sports enthusiast; focused on market microstructure and execution."},{"name":"Daniel Kasabov-Nouvion","role":"Co-founder","background":"Software engineer with a background in high-performance systems and competitive gaming (LoL)."},{"name":"Arthur Zhou","role":"Co-founder","background":"Product and infrastructure engineer; previously built social-gaming platforms (setwithfriends)."}],"founding_team":{"size":3,"key_expertise":"The team specializes in low-latency infrastructure, API design, and quantitative trading strategies, specifically tailored for the nascent prediction market asset class."},"traction":{"performance_metrics":["Processed over 1 Billion contracts through the platform since launch.","Grew monthly volume from 7 Million contracts in September 2025 to 250 Million by December 2025 (30x growth in 4 months).","Powers the trading for a top 3 trader on the Kalshi public leaderboard.","Users report an average of 200%+ month-over-month growth in trading volume after migrating to the Valence terminal."],"funding":{"latest_round":"Y Combinator Winter 2026 Batch","status":"Active / Seed Stage"}},"problem_statement":{"core_issue":"The prediction market landscape is highly fragmented, lacking the professional-grade infrastructure found in traditional equities or crypto markets.","barriers":["Fragmented Liquidity: Traders must manage separate accounts and interfaces for Kalshi, Polymarket, and others.","Underdeveloped Tooling: Existing exchanges focus on retail users, leaving systematic and algorithmic traders without robust APIs or backtesting tools.","Data Inconsistency: There is no unified data layer to match identical markets across different venues, leading to missed arbitrage opportunities."]},"solution":{"primary_product":"The Prediction Market Superapp","key_features":["Unified Orderbook: A single interface to view and trade across Kalshi, Polymarket, and Crypto.com.","Standardized API: One connector that works for every exchange, allowing algo-traders to deploy strategies once and run them everywhere.","Smart Routing: Automatically finds the cheapest contracts and deepest liquidity across multiple venues.","Historical Data: Proprietary datasets and backtesting engines to help traders find edge in event-based markets."],"value_proposition":"Valence acts as the 'execution layer' for the next generation of event-based finance, turning fragmented betting venues into a professional asset class."},"hypothetical_investment_rejection_reasoning":{"market_concentration_risk":"The 'Duopoly' Problem: Unlike the crypto exchange market (which has dozens of liquid venues), prediction markets in 2026 are heavily dominated by just two players: Polymarket (global) and Kalshi (U.S.). In a 'winner-takes-all' or 'winner-takes-most' scenario, the value of an aggregator is significantly diminished because traders don't need to 'aggregate' if 95% of the volume is on one platform.","platform_dependency":"Valence is entirely dependent on the goodwill of the underlying exchanges. If Kalshi or Polymarket decide to restrict API access or launch their own professional terminals, Valence’s core product could be rendered obsolete overnight (the 'Sherlocking' risk).","TAM_limitations":"While the total volume of prediction markets is growing, the subset of 'systematic/algo traders' who need a professional terminal is still relatively small. We are skeptical that the 'pro-trader' segment alone provides a large enough Total Addressable Market (TAM) to justify a venture-scale return.","Regulatory_Complexity":"Managing a unified interface that bridges CFTC-regulated U.S. exchanges (Kalshi) and offshore crypto-native platforms (Polymarket) creates a massive legal and compliance headache. The risk of being classified as an unregistered broker-dealer is a significant tail risk that we aren't comfortable with at this stage.","Execution_vs_Moat":"The product is impressive, but the 'moat' (defensibility) is low. Other well-funded trading platforms (like FalconX or even Interactive Brokers) could integrate these features as a minor update to their existing infrastructure once the market reaches sufficient maturity."},"critical_assumptions":[{"assumption_type":"pass_rationale","assumption_text":"Market Concentration Risk","must_be_true":"The 'Duopoly' Problem: Unlike the crypto exchange market (which has dozens of liquid venues), prediction markets in 2026 are heavily dominated by just two players: Polymarket (global) and Kalshi (U.S.). In a 'winner-takes-all' or 'winner-takes-most' scenario, the value of an aggregator is significantly diminished because traders don't need to 'aggregate' if 95% of the volume is on one platform.","failure_mode":"The 'Duopoly' Problem: Unlike the crypto exchange market (which has dozens of liquid venues), prediction markets in 2026 are heavily dominated by just two players: Polymarket (global) and Kalshi (U.S.). In a 'winner-takes-all' or 'winner-takes-most' scenario, the value of an aggregator is significantly diminished because traders don't need to 'aggregate' if 95% of the volume is on one platform.","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"Platform Dependency","must_be_true":"Valence is entirely dependent on the goodwill of the underlying exchanges. If Kalshi or Polymarket decide to restrict API access or launch their own professional terminals, Valence’s core product could be rendered obsolete overnight (the 'Sherlocking' risk).","failure_mode":"Valence is entirely dependent on the goodwill of the underlying exchanges. If Kalshi or Polymarket decide to restrict API access or launch their own professional terminals, Valence’s core product could be rendered obsolete overnight (the 'Sherlocking' risk).","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"TAM Limitations","must_be_true":"While the total volume of prediction markets is growing, the subset of 'systematic/algo traders' who need a professional terminal is still relatively small. We are skeptical that the 'pro-trader' segment alone provides a large enough Total Addressable Market (TAM) to justify a venture-scale return.","failure_mode":"While the total volume of prediction markets is growing, the subset of 'systematic/algo traders' who need a professional terminal is still relatively small. We are skeptical that the 'pro-trader' segment alone provides a large enough Total Addressable Market (TAM) to justify a venture-scale return.","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"Regulatory Complexity","must_be_true":"Managing a unified interface that bridges CFTC-regulated U.S. exchanges (Kalshi) and offshore crypto-native platforms (Polymarket) creates a massive legal and compliance headache. The risk of being classified as an unregistered broker-dealer is a significant tail risk that we aren't comfortable with at this stage.","failure_mode":"Managing a unified interface that bridges CFTC-regulated U.S. exchanges (Kalshi) and offshore crypto-native platforms (Polymarket) creates a massive legal and compliance headache. The risk of being classified as an unregistered broker-dealer is a significant tail risk that we aren't comfortable with at this stage.","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"Execution Vs Moat","must_be_true":"The product is impressive, but the 'moat' (defensibility) is low. Other well-funded trading platforms (like FalconX or even Interactive Brokers) could integrate these features as a minor update to their existing infrastructure once the market reaches sufficient maturity.","failure_mode":"The product is impressive, but the 'moat' (defensibility) is low. Other well-funded trading platforms (like FalconX or even Interactive Brokers) could integrate these features as a minor update to their existing infrastructure once the market reaches sufficient maturity.","is_linchpin":false}]}$j$::jsonb
);

INSERT INTO public.deal_problem (
  deal_id, analysis_id,
  problem_statement, root_cause_depth, economic_gravity, structural_urgency,
  persona_clarity, economic_buyer_persona, budget_priority_validation,
  stated_problem_ref, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  '1b000000-0000-4000-8000-000000000006'::uuid,
  'The prediction market landscape is highly fragmented, lacking the professional-grade infrastructure found in traditional equities or crypto markets.

Barriers:
1. Fragmented Liquidity: Traders must manage separate accounts and interfaces for Kalshi, Polymarket, and others.
2. Underdeveloped Tooling: Existing exchanges focus on retail users, leaving systematic and algorithmic traders without robust APIs or backtesting tools.
3. Data Inconsistency: There is no unified data layer to match identical markets across different venues, leading to missed arbitrage opportunities.',
  'Fragmented Liquidity: Traders must manage separate accounts and interfaces for Kalshi, Polymarket, and others.',
  'Economic impact implied by: Fragmented Liquidity: Traders must manage separate accounts and interfaces for Kalshi, Polymarket, and others. Underdeveloped Tooling: Existing exchanges focus on retail users, leaving systematic and algorithmic traders without robust APIs or backtesting tools.',
  '1. Fragmented Liquidity: Traders must manage separate accounts and interfaces for Kalshi, Polymarket, and others.
2. Underdeveloped Tooling: Existing exchanges focus on retail users, leaving systematic and algorithmic traders without robust APIs or backtesting tools.
3. Data Inconsistency: There is no unified data layer to match identical markets across different venues, leading to missed arbitrage opportunities.',
  'Pro user or consumer',
  'Pro user or consumer',
  NULL,
  'The prediction market landscape is highly fragmented, lacking the professional-grade infrastructure found in traditional equities or crypto markets.',
  'historical_seed'
);

INSERT INTO public.deal_solution (
  deal_id, analysis_id,
  solution_summary, product_type, moat_type, replication_difficulty, compounding_potential,
  technical_moat_evidence, differentiation_proof_points, competitor_landscape_json, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  '1b000000-0000-4000-8000-000000000006'::uuid,
  'The Prediction Market Superapp

Valence acts as the ''execution layer'' for the next generation of event-based finance, turning fragmented betting venues into a professional asset class.',
  'The Prediction Market Superapp',
  'network + integrations',
  'High replication cost: Unified Orderbook: A single interface to view and trade across Kalshi, Polymarket, and Crypto.com.; Standardized API: One connector that works for every exchange, allowing algo-traders to deploy strategies once and run them everywhere.',
  'Compounding via: Valence acts as the ''execution layer'' for the next generation of event-based finance, turning fragmented betting venues into a professional asset class.',
  'Unified Orderbook: A single interface to view and trade across Kalshi, Polymarket, and Crypto.com.
Standardized API: One connector that works for every exchange, allowing algo-traders to deploy strategies once and run them everywhere.
Smart Routing: Automatically finds the cheapest contracts and deepest liquidity across multiple venues.
Historical Data: Proprietary datasets and backtesting engines to help traders find edge in event-based markets.',
  $j$["Unified Orderbook: A single interface to view and trade across Kalshi, Polymarket, and Crypto.com.","Standardized API: One connector that works for every exchange, allowing algo-traders to deploy strategies once and run them everywhere.","Smart Routing: Automatically finds the cheapest contracts and deepest liquidity across multiple venues.","Historical Data: Proprietary datasets and backtesting engines to help traders find edge in event-based markets."]$j$::jsonb,
  $j$[{"name":"Kalshi","category":"incumbent / alternative","note":"Referenced in source narrative"},{"name":"Polymarket","category":"incumbent / alternative","note":"Referenced in source narrative"},{"name":"Interactive Brokers","category":"incumbent / alternative","note":"Referenced in source narrative"},{"name":"FalconX","category":"incumbent / alternative","note":"Referenced in source narrative"},{"name":"Crypto.com","category":"incumbent / alternative","note":"Referenced in source narrative"}]$j$::jsonb,
  'historical_seed'
);

INSERT INTO public.deal_traction (
  deal_id, analysis_id,
  traction_evidence_json, phase1_traction_json, milestones_detected,
  inferred_stage, benchmark_context, revenue_data, growth_signals, customer_depth, user_traction,
  notable_partners_and_validation, investor_list, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  '1b000000-0000-4000-8000-000000000006'::uuid,
  $j${"performance_metrics":["Processed over 1 Billion contracts through the platform since launch.","Grew monthly volume from 7 Million contracts in September 2025 to 250 Million by December 2025 (30x growth in 4 months).","Powers the trading for a top 3 trader on the Kalshi public leaderboard.","Users report an average of 200%+ month-over-month growth in trading volume after migrating to the Valence terminal."],"funding":{"latest_round":"Y Combinator Winter 2026 Batch","status":"Active / Seed Stage"}}$j$::jsonb,
  $j${"performance_metrics":["Processed over 1 Billion contracts through the platform since launch.","Grew monthly volume from 7 Million contracts in September 2025 to 250 Million by December 2025 (30x growth in 4 months).","Powers the trading for a top 3 trader on the Kalshi public leaderboard.","Users report an average of 200%+ month-over-month growth in trading volume after migrating to the Valence terminal."],"funding":{"latest_round":"Y Combinator Winter 2026 Batch","status":"Active / Seed Stage"}}$j$::jsonb,
  $j$["Processed over 1 Billion contracts through the platform since launch.","Grew monthly volume from 7 Million contracts in September 2025 to 250 Million by December 2025 (30x growth in 4 months).","Powers the trading for a top 3 trader on the Kalshi public leaderboard.","Users report an average of 200%+ month-over-month growth in trading volume after migrating to the Valence terminal."]$j$::jsonb,
  'Founded 2025',
  'HQ: New York, NY | Founded: 2025 | Round: Y Combinator Winter 2026 Batch',
  'Processed over 1 Billion contracts through the platform since launch.
Grew monthly volume from 7 Million contracts in September 2025 to 250 Million by December 2025 (30x growth in 4 months).
Users report an average of 200%+ month-over-month growth in trading volume after migrating to the Valence terminal.',
  'Grew monthly volume from 7 Million contracts in September 2025 to 250 Million by December 2025 (30x growth in 4 months).
Users report an average of 200%+ month-over-month growth in trading volume after migrating to the Valence terminal.',
  'Users report an average of 200%+ month-over-month growth in trading volume after migrating to the Valence terminal.',
  'Processed over 1 Billion contracts through the platform since launch.
Grew monthly volume from 7 Million contracts in September 2025 to 250 Million by December 2025 (30x growth in 4 months).
Powers the trading for a top 3 trader on the Kalshi public leaderboard.
Users report an average of 200%+ month-over-month growth in trading volume after migrating to the Valence terminal.',
  $j$["Processed over 1 Billion contracts through the platform since launch.","Grew monthly volume from 7 Million contracts in September 2025 to 250 Million by December 2025 (30x growth in 4 months).","Powers the trading for a top 3 trader on the Kalshi public leaderboard.","Users report an average of 200%+ month-over-month growth in trading volume after migrating to the Valence terminal."]$j$::jsonb,
  NULL,
  'historical_seed'
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  'founded_year',
  '2025',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  'headquarters',
  'New York, NY',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  'latest_round',
  'Y Combinator Winter 2026 Batch',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  'funding_status',
  'Active / Seed Stage',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  'traction_highlight_1',
  'Processed over 1 Billion contracts through the platform since launch.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  'traction_highlight_2',
  'Grew monthly volume from 7 Million contracts in September 2025 to 250 Million by December 2025 (30x growth in 4 months).',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  'traction_highlight_3',
  'Powers the trading for a top 3 trader on the Kalshi public leaderboard.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  'traction_highlight_4',
  'Users report an average of 200%+ month-over-month growth in trading volume after migrating to the Valence terminal.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  '1b000000-0000-4000-8000-000000000006'::uuid,
  'Kalshi',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  '1b000000-0000-4000-8000-000000000006'::uuid,
  'Polymarket',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  '1b000000-0000-4000-8000-000000000006'::uuid,
  'Interactive Brokers',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  '1b000000-0000-4000-8000-000000000006'::uuid,
  'FalconX',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  '1b000000-0000-4000-8000-000000000006'::uuid,
  'Crypto.com',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  '1b000000-0000-4000-8000-000000000006'::uuid,
  'Market Concentration Risk',
  'pass_rationale',
  NULL,
  'The ''Duopoly'' Problem: Unlike the crypto exchange market (which has dozens of liquid venues), prediction markets in 2026 are heavily dominated by just two players: Polymarket (global) and Kalshi (U.S.). In a ''winner-takes-all'' or ''winner-takes-most'' scenario, the value of an aggregator is significantly diminished because traders don''t need to ''aggregate'' if 95% of the volume is on one platform.',
  false,
  NULL,
  NULL,
  'The ''Duopoly'' Problem: Unlike the crypto exchange market (which has dozens of liquid venues), prediction markets in 2026 are heavily dominated by just two players: Polymarket (global) and Kalshi (U.S.). In a ''winner-takes-all'' or ''winner-takes-most'' scenario, the value of an aggregator is significantly diminished because traders don''t need to ''aggregate'' if 95% of the volume is on one platform.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  '1b000000-0000-4000-8000-000000000006'::uuid,
  'Platform Dependency',
  'pass_rationale',
  NULL,
  'Valence is entirely dependent on the goodwill of the underlying exchanges. If Kalshi or Polymarket decide to restrict API access or launch their own professional terminals, Valence’s core product could be rendered obsolete overnight (the ''Sherlocking'' risk).',
  false,
  NULL,
  NULL,
  'Valence is entirely dependent on the goodwill of the underlying exchanges. If Kalshi or Polymarket decide to restrict API access or launch their own professional terminals, Valence’s core product could be rendered obsolete overnight (the ''Sherlocking'' risk).'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  '1b000000-0000-4000-8000-000000000006'::uuid,
  'TAM Limitations',
  'pass_rationale',
  NULL,
  'While the total volume of prediction markets is growing, the subset of ''systematic/algo traders'' who need a professional terminal is still relatively small. We are skeptical that the ''pro-trader'' segment alone provides a large enough Total Addressable Market (TAM) to justify a venture-scale return.',
  false,
  NULL,
  NULL,
  'While the total volume of prediction markets is growing, the subset of ''systematic/algo traders'' who need a professional terminal is still relatively small. We are skeptical that the ''pro-trader'' segment alone provides a large enough Total Addressable Market (TAM) to justify a venture-scale return.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  '1b000000-0000-4000-8000-000000000006'::uuid,
  'Regulatory Complexity',
  'pass_rationale',
  NULL,
  'Managing a unified interface that bridges CFTC-regulated U.S. exchanges (Kalshi) and offshore crypto-native platforms (Polymarket) creates a massive legal and compliance headache. The risk of being classified as an unregistered broker-dealer is a significant tail risk that we aren''t comfortable with at this stage.',
  false,
  NULL,
  NULL,
  'Managing a unified interface that bridges CFTC-regulated U.S. exchanges (Kalshi) and offshore crypto-native platforms (Polymarket) creates a massive legal and compliance headache. The risk of being classified as an unregistered broker-dealer is a significant tail risk that we aren''t comfortable with at this stage.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  '1b000000-0000-4000-8000-000000000006'::uuid,
  'Execution Vs Moat',
  'pass_rationale',
  NULL,
  'The product is impressive, but the ''moat'' (defensibility) is low. Other well-funded trading platforms (like FalconX or even Interactive Brokers) could integrate these features as a minor update to their existing infrastructure once the market reaches sufficient maturity.',
  false,
  NULL,
  NULL,
  'The product is impressive, but the ''moat'' (defensibility) is low. Other well-funded trading platforms (like FalconX or even Interactive Brokers) could integrate these features as a minor update to their existing infrastructure once the market reaches sufficient maturity.'
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  'Neo Wang',
  'Co-founder',
  'Quantitative trader and sports enthusiast; focused on market microstructure and execution.',
  NULL,
  'YC Winter 2026',
  NULL,
  NULL,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Neo Wang","role":"Co-founder","background":"Quantitative trader and sports enthusiast; focused on market microstructure and execution."}$j$::jsonb
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  'Daniel Kasabov-Nouvion',
  'Co-founder',
  'Software engineer with a background in high-performance systems and competitive gaming (LoL).',
  NULL,
  'YC Winter 2026',
  NULL,
  NULL,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Daniel Kasabov-Nouvion","role":"Co-founder","background":"Software engineer with a background in high-performance systems and competitive gaming (LoL)."}$j$::jsonb
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000006'::uuid,
  'Arthur Zhou',
  'Co-founder',
  'Product and infrastructure engineer; previously built social-gaming platforms (setwithfriends).',
  NULL,
  'YC Winter 2026',
  NULL,
  NULL,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Arthur Zhou","role":"Co-founder","background":"Product and infrastructure engineer; previously built social-gaming platforms (setwithfriends)."}$j$::jsonb
);

INSERT INTO public.deals (id, user_id, company_name, geography, decision, source, pass_reason, pass_reason_detail)
VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  'REPLACE_WITH_YOUR_USER_UUID'::uuid,
  'SpotPay',
  'San Francisco, CA',
  'passed',
  'invested-companies-md',
  'hypothetical_rejection',
  '{"red_ocean_competition":"The space is incredibly crowded with heavily-capitalized incumbents like Wise, Revolut, and Airwallex. While SpotPay has early traction, they lack a structural ''moat'' to prevent these giants from simply toggling on stablecoin features for their existing millions of users.","neobank_commoditization":"As financial infrastructure platforms (like Stripe or Adyen) move closer to the metal, the value of a standalone ''neobank'' brand is declining. We believe value is shifting to the underlying infrastructure layers rather than the consumer-facing wallet.","regulatory_tail_risk":"Operating a stablecoin-native bank in emerging markets is a legal minefield. A single regulatory crackdown on ''unlicensed'' money transmission or stablecoin custody in a key market like Mexico or Brazil could wipe out their primary growth engine.","margin_erosion":"The ''race to zero'' on cross-border fees makes it difficult to build a high-margin business. Unless SpotPay can successfully cross-sell high-margin credit products—which introduces significant balance-sheet risk—the unit economics remain challenging at scale.","customer_acquisition_costs":"Acquiring users in the LatAm/Caribbean region is notoriously expensive and operationally intensive. We are concerned that their 43% WoW growth is a ''honeymoon'' phase that will normalize into a high-CAC, low-LTV (Life Time Value) trap."}'
);

INSERT INTO public.deal_analyses (id, deal_id, pipeline_version, raw_output)
VALUES (
  '1b000000-0000-4000-8000-000000000007'::uuid,
  '1a000000-0000-4000-8000-000000000007'::uuid,
  2,
  $j${"company_name":"SpotPay","founded_year":2025,"headquarters":"San Francisco, CA","founders":[{"name":"Zsika Phillip-Baptiste","role":"Co-founder & CEO","background":"Stanford MBA candidate; former Product Manager at Google and Software Engineer at YouTube; previously founded Astros AI."},{"name":"Thomas Cesare-Herriau","role":"Co-founder & CTO","background":"Software engineer with deep expertise in full-stack development and high-scale financial infrastructure."}],"founding_team":{"key_expertise":"The team leverages a mix of Big Tech product experience (Google/YouTube) and early-stage startup agility, focused on bridging traditional finance with blockchain rails.","specialization":"Specialists in stablecoin liquidity, mobile UX, and cross-border regulatory compliance."},"traction":{"funding":{"total_funding":"$500,000","latest_round":"Y Combinator Winter 2026 Batch ($450k - $500k standard deal)","lead_investors":"Y Combinator","participating_investors":["Alliance (Web3 Accelerator)","F4 Fund"]},"business_metrics":["Reported 43% week-over-week growth in Total Payment Volume (TPV) during early 2026.","Launched the 'Calypso Card,' a physical global spending card tied to stablecoin balances.","Growing presence in emerging market corridors, specifically the Latin American and Caribbean regions."]},"problem_statement":{"core_issue":"Cross-border finance is fundamentally broken for individuals and small businesses in emerging markets.","barriers":["The 'SWIFT' Tax: Traditional transfers take 3–5 days and lose 5–7% in hidden FX fees and intermediary bank charges.","Financial Exclusion: High minimum balances and strict documentation requirements keep millions 'unbanked' or 'underbanked' globally.","Currency Volatility: Users in hyper-inflationary environments lack easy, cheap access to stable-value assets like the US Dollar."]},"solution":{"primary_product":"Borderless Neobank & Digital Wallet","key_features":["Stablecoin Rails: Uses blockchain and USDC/USDT to settle international transfers in under 3 minutes.","QR-Based Local Payments: Enables users to pay local merchants directly from their digital wallet via integrated QR codes.","AI-Powered Insights: An embedded agent that analyzes spending patterns to suggest automated savings and yield-bearing opportunities.","Yield-on-Store: Allows users to earn interest on their digital dollar balances through audited DeFi protocols."],"value_proposition":"Providing a 'global bank account in your pocket' that bypasses the friction of local legacy banking for the next billion users."},"hypothetical_investment_rejection_reasoning":{"red_ocean_competition":"The space is incredibly crowded with heavily-capitalized incumbents like Wise, Revolut, and Airwallex. While SpotPay has early traction, they lack a structural 'moat' to prevent these giants from simply toggling on stablecoin features for their existing millions of users.","neobank_commoditization":"As financial infrastructure platforms (like Stripe or Adyen) move closer to the metal, the value of a standalone 'neobank' brand is declining. We believe value is shifting to the underlying infrastructure layers rather than the consumer-facing wallet.","regulatory_tail_risk":"Operating a stablecoin-native bank in emerging markets is a legal minefield. A single regulatory crackdown on 'unlicensed' money transmission or stablecoin custody in a key market like Mexico or Brazil could wipe out their primary growth engine.","margin_erosion":"The 'race to zero' on cross-border fees makes it difficult to build a high-margin business. Unless SpotPay can successfully cross-sell high-margin credit products—which introduces significant balance-sheet risk—the unit economics remain challenging at scale.","customer_acquisition_costs":"Acquiring users in the LatAm/Caribbean region is notoriously expensive and operationally intensive. We are concerned that their 43% WoW growth is a 'honeymoon' phase that will normalize into a high-CAC, low-LTV (Life Time Value) trap."},"critical_assumptions":[{"assumption_type":"pass_rationale","assumption_text":"Red Ocean Competition","must_be_true":"The space is incredibly crowded with heavily-capitalized incumbents like Wise, Revolut, and Airwallex. While SpotPay has early traction, they lack a structural 'moat' to prevent these giants from simply toggling on stablecoin features for their existing millions of users.","failure_mode":"The space is incredibly crowded with heavily-capitalized incumbents like Wise, Revolut, and Airwallex. While SpotPay has early traction, they lack a structural 'moat' to prevent these giants from simply toggling on stablecoin features for their existing millions of users.","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"Neobank Commoditization","must_be_true":"As financial infrastructure platforms (like Stripe or Adyen) move closer to the metal, the value of a standalone 'neobank' brand is declining. We believe value is shifting to the underlying infrastructure layers rather than the consumer-facing wallet.","failure_mode":"As financial infrastructure platforms (like Stripe or Adyen) move closer to the metal, the value of a standalone 'neobank' brand is declining. We believe value is shifting to the underlying infrastructure layers rather than the consumer-facing wallet.","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"Regulatory Tail Risk","must_be_true":"Operating a stablecoin-native bank in emerging markets is a legal minefield. A single regulatory crackdown on 'unlicensed' money transmission or stablecoin custody in a key market like Mexico or Brazil could wipe out their primary growth engine.","failure_mode":"Operating a stablecoin-native bank in emerging markets is a legal minefield. A single regulatory crackdown on 'unlicensed' money transmission or stablecoin custody in a key market like Mexico or Brazil could wipe out their primary growth engine.","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"Margin Erosion","must_be_true":"The 'race to zero' on cross-border fees makes it difficult to build a high-margin business. Unless SpotPay can successfully cross-sell high-margin credit products—which introduces significant balance-sheet risk—the unit economics remain challenging at scale.","failure_mode":"The 'race to zero' on cross-border fees makes it difficult to build a high-margin business. Unless SpotPay can successfully cross-sell high-margin credit products—which introduces significant balance-sheet risk—the unit economics remain challenging at scale.","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"Customer Acquisition Costs","must_be_true":"Acquiring users in the LatAm/Caribbean region is notoriously expensive and operationally intensive. We are concerned that their 43% WoW growth is a 'honeymoon' phase that will normalize into a high-CAC, low-LTV (Life Time Value) trap.","failure_mode":"Acquiring users in the LatAm/Caribbean region is notoriously expensive and operationally intensive. We are concerned that their 43% WoW growth is a 'honeymoon' phase that will normalize into a high-CAC, low-LTV (Life Time Value) trap.","is_linchpin":false}]}$j$::jsonb
);

INSERT INTO public.deal_problem (
  deal_id, analysis_id,
  problem_statement, root_cause_depth, economic_gravity, structural_urgency,
  persona_clarity, economic_buyer_persona, budget_priority_validation,
  stated_problem_ref, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  '1b000000-0000-4000-8000-000000000007'::uuid,
  'Cross-border finance is fundamentally broken for individuals and small businesses in emerging markets.

Barriers:
1. The ''SWIFT'' Tax: Traditional transfers take 3–5 days and lose 5–7% in hidden FX fees and intermediary bank charges.
2. Financial Exclusion: High minimum balances and strict documentation requirements keep millions ''unbanked'' or ''underbanked'' globally.
3. Currency Volatility: Users in hyper-inflationary environments lack easy, cheap access to stable-value assets like the US Dollar.',
  'The ''SWIFT'' Tax: Traditional transfers take 3–5 days and lose 5–7% in hidden FX fees and intermediary bank charges.',
  'Economic impact implied by: The ''SWIFT'' Tax: Traditional transfers take 3–5 days and lose 5–7% in hidden FX fees and intermediary bank charges. Financial Exclusion: High minimum balances and strict documentation requirements keep millions ''unbanked'' or ''underbanked'' globally.',
  '1. The ''SWIFT'' Tax: Traditional transfers take 3–5 days and lose 5–7% in hidden FX fees and intermediary bank charges.
2. Financial Exclusion: High minimum balances and strict documentation requirements keep millions ''unbanked'' or ''underbanked'' globally.
3. Currency Volatility: Users in hyper-inflationary environments lack easy, cheap access to stable-value assets like the US Dollar.',
  'SMB / operator buyer',
  'SMB / operator buyer',
  'The ''SWIFT'' Tax: Traditional transfers take 3–5 days and lose 5–7% in hidden FX fees and intermediary bank charges.',
  'Cross-border finance is fundamentally broken for individuals and small businesses in emerging markets.',
  'historical_seed'
);

INSERT INTO public.deal_solution (
  deal_id, analysis_id,
  solution_summary, product_type, moat_type, replication_difficulty, compounding_potential,
  technical_moat_evidence, differentiation_proof_points, competitor_landscape_json, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  '1b000000-0000-4000-8000-000000000007'::uuid,
  'Borderless Neobank & Digital Wallet

Providing a ''global bank account in your pocket'' that bypasses the friction of local legacy banking for the next billion users.',
  'Borderless Neobank & Digital Wallet',
  'technical / data',
  'High replication cost: Stablecoin Rails: Uses blockchain and USDC/USDT to settle international transfers in under 3 minutes.; QR-Based Local Payments: Enables users to pay local merchants directly from their digital wallet via integrated QR codes.',
  'Compounding via: Providing a ''global bank account in your pocket'' that bypasses the friction of local legacy banking for the next billion users.',
  'Stablecoin Rails: Uses blockchain and USDC/USDT to settle international transfers in under 3 minutes.
QR-Based Local Payments: Enables users to pay local merchants directly from their digital wallet via integrated QR codes.
AI-Powered Insights: An embedded agent that analyzes spending patterns to suggest automated savings and yield-bearing opportunities.
Yield-on-Store: Allows users to earn interest on their digital dollar balances through audited DeFi protocols.',
  $j$["Stablecoin Rails: Uses blockchain and USDC/USDT to settle international transfers in under 3 minutes.","QR-Based Local Payments: Enables users to pay local merchants directly from their digital wallet via integrated QR codes.","AI-Powered Insights: An embedded agent that analyzes spending patterns to suggest automated savings and yield-bearing opportunities.","Yield-on-Store: Allows users to earn interest on their digital dollar balances through audited DeFi protocols."]$j$::jsonb,
  $j$[{"name":"Wise","category":"incumbent / alternative","note":"Referenced in source narrative"},{"name":"Revolut","category":"incumbent / alternative","note":"Referenced in source narrative"},{"name":"Airwallex","category":"incumbent / alternative","note":"Referenced in source narrative"},{"name":"Stripe","category":"incumbent / alternative","note":"Referenced in source narrative"},{"name":"Adyen","category":"incumbent / alternative","note":"Referenced in source narrative"}]$j$::jsonb,
  'historical_seed'
);

INSERT INTO public.deal_traction (
  deal_id, analysis_id,
  traction_evidence_json, phase1_traction_json, milestones_detected,
  inferred_stage, benchmark_context, revenue_data, growth_signals, customer_depth, user_traction,
  notable_partners_and_validation, investor_list, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  '1b000000-0000-4000-8000-000000000007'::uuid,
  $j${"funding":{"total_funding":"$500,000","latest_round":"Y Combinator Winter 2026 Batch ($450k - $500k standard deal)","lead_investors":"Y Combinator","participating_investors":["Alliance (Web3 Accelerator)","F4 Fund"]},"business_metrics":["Reported 43% week-over-week growth in Total Payment Volume (TPV) during early 2026.","Launched the 'Calypso Card,' a physical global spending card tied to stablecoin balances.","Growing presence in emerging market corridors, specifically the Latin American and Caribbean regions."]}$j$::jsonb,
  $j${"funding":{"total_funding":"$500,000","latest_round":"Y Combinator Winter 2026 Batch ($450k - $500k standard deal)","lead_investors":"Y Combinator","participating_investors":["Alliance (Web3 Accelerator)","F4 Fund"]},"business_metrics":["Reported 43% week-over-week growth in Total Payment Volume (TPV) during early 2026.","Launched the 'Calypso Card,' a physical global spending card tied to stablecoin balances.","Growing presence in emerging market corridors, specifically the Latin American and Caribbean regions."]}$j$::jsonb,
  $j$["Reported 43% week-over-week growth in Total Payment Volume (TPV) during early 2026.","Launched the 'Calypso Card,' a physical global spending card tied to stablecoin balances.","Growing presence in emerging market corridors, specifically the Latin American and Caribbean regions."]$j$::jsonb,
  'Founded 2025',
  'HQ: San Francisco, CA | Founded: 2025 | Round: Y Combinator Winter 2026 Batch ($450k - $500k standard deal)',
  'Reported 43% week-over-week growth in Total Payment Volume (TPV) during early 2026.',
  'Reported 43% week-over-week growth in Total Payment Volume (TPV) during early 2026.',
  NULL,
  'Reported 43% week-over-week growth in Total Payment Volume (TPV) during early 2026.',
  $j$["Reported 43% week-over-week growth in Total Payment Volume (TPV) during early 2026.","Launched the 'Calypso Card,' a physical global spending card tied to stablecoin balances.","Growing presence in emerging market corridors, specifically the Latin American and Caribbean regions."]$j$::jsonb,
  $j$[{"name":"Y Combinator","role":"lead"},{"name":"Alliance (Web3 Accelerator)","role":"participant"},{"name":"F4 Fund","role":"participant"}]$j$::jsonb,
  'historical_seed'
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  'founded_year',
  '2025',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  'headquarters',
  'San Francisco, CA',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  'total_funding',
  '$500,000',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  'latest_round',
  'Y Combinator Winter 2026 Batch ($450k - $500k standard deal)',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  'traction_highlight_1',
  'Reported 43% week-over-week growth in Total Payment Volume (TPV) during early 2026.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  'traction_highlight_2',
  'Launched the ''Calypso Card,'' a physical global spending card tied to stablecoin balances.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  'traction_highlight_3',
  'Growing presence in emerging market corridors, specifically the Latin American and Caribbean regions.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  '1b000000-0000-4000-8000-000000000007'::uuid,
  'Wise',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  '1b000000-0000-4000-8000-000000000007'::uuid,
  'Revolut',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  '1b000000-0000-4000-8000-000000000007'::uuid,
  'Airwallex',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  '1b000000-0000-4000-8000-000000000007'::uuid,
  'Stripe',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  '1b000000-0000-4000-8000-000000000007'::uuid,
  'Adyen',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  '6d8c434a-d078-46a9-af0f-a7107f271f90'::uuid,
  'lead',
  'Y Combinator Winter 2026 Batch ($450k - $500k standard deal)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  'ca820f38-929c-43ac-ad26-3a828b8007b9'::uuid,
  'participant',
  'Y Combinator Winter 2026 Batch ($450k - $500k standard deal)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  '33e123f9-e32b-4b1d-ad6c-fca393113ab6'::uuid,
  'participant',
  'Y Combinator Winter 2026 Batch ($450k - $500k standard deal)',
  NULL
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  '1b000000-0000-4000-8000-000000000007'::uuid,
  'Red Ocean Competition',
  'pass_rationale',
  NULL,
  'The space is incredibly crowded with heavily-capitalized incumbents like Wise, Revolut, and Airwallex. While SpotPay has early traction, they lack a structural ''moat'' to prevent these giants from simply toggling on stablecoin features for their existing millions of users.',
  false,
  NULL,
  NULL,
  'The space is incredibly crowded with heavily-capitalized incumbents like Wise, Revolut, and Airwallex. While SpotPay has early traction, they lack a structural ''moat'' to prevent these giants from simply toggling on stablecoin features for their existing millions of users.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  '1b000000-0000-4000-8000-000000000007'::uuid,
  'Neobank Commoditization',
  'pass_rationale',
  NULL,
  'As financial infrastructure platforms (like Stripe or Adyen) move closer to the metal, the value of a standalone ''neobank'' brand is declining. We believe value is shifting to the underlying infrastructure layers rather than the consumer-facing wallet.',
  false,
  NULL,
  NULL,
  'As financial infrastructure platforms (like Stripe or Adyen) move closer to the metal, the value of a standalone ''neobank'' brand is declining. We believe value is shifting to the underlying infrastructure layers rather than the consumer-facing wallet.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  '1b000000-0000-4000-8000-000000000007'::uuid,
  'Regulatory Tail Risk',
  'pass_rationale',
  NULL,
  'Operating a stablecoin-native bank in emerging markets is a legal minefield. A single regulatory crackdown on ''unlicensed'' money transmission or stablecoin custody in a key market like Mexico or Brazil could wipe out their primary growth engine.',
  false,
  NULL,
  NULL,
  'Operating a stablecoin-native bank in emerging markets is a legal minefield. A single regulatory crackdown on ''unlicensed'' money transmission or stablecoin custody in a key market like Mexico or Brazil could wipe out their primary growth engine.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  '1b000000-0000-4000-8000-000000000007'::uuid,
  'Margin Erosion',
  'pass_rationale',
  NULL,
  'The ''race to zero'' on cross-border fees makes it difficult to build a high-margin business. Unless SpotPay can successfully cross-sell high-margin credit products—which introduces significant balance-sheet risk—the unit economics remain challenging at scale.',
  false,
  NULL,
  NULL,
  'The ''race to zero'' on cross-border fees makes it difficult to build a high-margin business. Unless SpotPay can successfully cross-sell high-margin credit products—which introduces significant balance-sheet risk—the unit economics remain challenging at scale.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  '1b000000-0000-4000-8000-000000000007'::uuid,
  'Customer Acquisition Costs',
  'pass_rationale',
  NULL,
  'Acquiring users in the LatAm/Caribbean region is notoriously expensive and operationally intensive. We are concerned that their 43% WoW growth is a ''honeymoon'' phase that will normalize into a high-CAC, low-LTV (Life Time Value) trap.',
  false,
  NULL,
  NULL,
  'Acquiring users in the LatAm/Caribbean region is notoriously expensive and operationally intensive. We are concerned that their 43% WoW growth is a ''honeymoon'' phase that will normalize into a high-CAC, low-LTV (Life Time Value) trap.'
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  'Zsika Phillip-Baptiste',
  'Co-founder & CEO',
  'Stanford MBA candidate; former Product Manager at Google and Software Engineer at YouTube; previously founded Astros AI.',
  ARRAY['Stanford']::text[],
  'YC Winter 2026',
  $j$["YouTube"]$j$::jsonb,
  $j$["Stanford","Google and Software Engineer at YouTube"]$j$::jsonb,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Zsika Phillip-Baptiste","role":"Co-founder & CEO","background":"Stanford MBA candidate; former Product Manager at Google and Software Engineer at YouTube; previously founded Astros AI."}$j$::jsonb
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000007'::uuid,
  'Thomas Cesare-Herriau',
  'Co-founder & CTO',
  'Software engineer with deep expertise in full-stack development and high-scale financial infrastructure.',
  NULL,
  'YC Winter 2026',
  NULL,
  NULL,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Thomas Cesare-Herriau","role":"Co-founder & CTO","background":"Software engineer with deep expertise in full-stack development and high-scale financial infrastructure."}$j$::jsonb
);

INSERT INTO public.deals (id, user_id, company_name, geography, decision, source, pass_reason, pass_reason_detail)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  'REPLACE_WITH_YOUR_USER_UUID'::uuid,
  'Avallon AI',
  'New York, NY',
  'passed',
  'invested-companies-md',
  'hypothetical_rejection',
  '{"market_saturation":"The ''AI Agent'' field is currently the most crowded sector in venture capital. We see hundreds of companies building ''AI for Insurance,'' and we are concerned that Avallon may struggle to maintain its 10x growth once incumbents like Salesforce and Guidewire release their own native agentic features.","integration_longevity":"The insurance industry is notorious for ''Integration Hell.'' While Avallon has succeeded with smaller TPAs, the technical debt required to integrate with the bespoke legacy systems of top-tier carriers (like State Farm or Geico) may slow their scaling velocity and hurt long-term margins.","liability_tail_risk":"Insurance claims involve high financial and legal stakes. A single ''hallucination'' where an AI agent misinterprets a policy term or incorrectly accepts liability could result in massive lawsuits. We aren''t yet convinced that the ''Human-in-the-Loop'' safeguards are robust enough to mitigate this systemic risk.","moat_defensibility":"As LLM capabilities become commoditized, the ''moat'' for Avallon shifts entirely to their specific workflow data and integrations. We worry that if OpenAI or Anthropic releases more specialized ''insurance-tuned'' models, the proprietary value of Avallon''s current agentic layer might diminish.","sales_cycle_fatigue":"While TPAs are a great entry point, the real volume is in the major carriers. These companies have 18–24 month sales cycles. We are hesitant to invest in a business that could face a significant ''revenue plateau'' while waiting for enterprise-scale approvals."}'
);

INSERT INTO public.deal_analyses (id, deal_id, pipeline_version, raw_output)
VALUES (
  '1b000000-0000-4000-8000-000000000008'::uuid,
  '1a000000-0000-4000-8000-000000000008'::uuid,
  2,
  $j${"company_name":"Avallon AI","founded_year":2025,"headquarters":"New York, NY","founders":[{"name":"Cornelius Schramm","role":"Co-founder & CEO","background":"Founding U.S. engineer at FINN (built operations for $15M ARR); experienced in scaling fleet operations."},{"name":"Bryan Guin","role":"Co-founder & COO","background":"Former product leader at EY (consulting for Fortune 500s); ML researcher at Cornell."},{"name":"Jet Semrick","role":"Co-founder & CTO","background":"Specialist in quantitative trading algorithms; national champion policy debater."}],"founding_team":{"size":7,"key_expertise":"The team includes specialists in operations research, machine learning, and enterprise software, with additional co-founding members Moritz Bartusch and Leander Peter.","specialization":"Deep focus on agentic workflows, conversational AI, and insurance-specific data models."},"traction":{"funding":{"total_funding":"$5.1 Million","latest_round":"$4.6 Million Seed (November 2025)","lead_investor":"Frontline Ventures","participating_investors":["Y Combinator (Spring 2025 Batch)","1984 Ventures","Liquid 2 Ventures","Booom Ventures"]},"business_metrics":["Achieved 10x revenue growth during the 3-month Y Combinator period.","Secured major contracts with Third-Party Administrators (TPAs) including Athens Administrators.","Live with multiple partners managing over 400 adjusters and thousands of claims.","Reported cutting claims processing time by up to 90% for pilot customers."]},"problem_statement":{"core_issue":"The insurance claims industry is facing a massive 'labor cliff' where adjusters are retiring faster than they can be replaced, leading to service delays and burnout.","barriers":["Fragmented Communication: Adjusters spend 60% of their time on 'phone tag' and routine status updates.","Unstructured Data: Sifting through thousands of PDFs, medical bills, and photos manually is slow and error-prone.","Legacy Systems: Most carriers use 20-year-old Claims Management Systems (CMS) that lack modern automation capabilities."]},"solution":{"primary_product":"AI-Native Claims Operations Platform","key_features":["Multimodal AI Agents: Autonomous agents that handle phone calls (intake/status), email triage, and document parsing (extracting data from medical reports).","End-to-End Orchestration: Moves a claim from initial report to settlement without requiring manual data entry at every step.","Write-Back Integration: Plugs directly into legacy CMS platforms to keep records updated in real-time.","Liability Copilot: Analyzes policy terms and flags potential exposures for adjusters to review, ensuring consistency in decisions."],"value_proposition":"Transforming claims from a manual cost center into a high-speed, automated operation that allows human adjusters to focus on high-stakes decision-making."},"hypothetical_investment_rejection_reasoning":{"market_saturation":"The 'AI Agent' field is currently the most crowded sector in venture capital. We see hundreds of companies building 'AI for Insurance,' and we are concerned that Avallon may struggle to maintain its 10x growth once incumbents like Salesforce and Guidewire release their own native agentic features.","integration_longevity":"The insurance industry is notorious for 'Integration Hell.' While Avallon has succeeded with smaller TPAs, the technical debt required to integrate with the bespoke legacy systems of top-tier carriers (like State Farm or Geico) may slow their scaling velocity and hurt long-term margins.","liability_tail_risk":"Insurance claims involve high financial and legal stakes. A single 'hallucination' where an AI agent misinterprets a policy term or incorrectly accepts liability could result in massive lawsuits. We aren't yet convinced that the 'Human-in-the-Loop' safeguards are robust enough to mitigate this systemic risk.","moat_defensibility":"As LLM capabilities become commoditized, the 'moat' for Avallon shifts entirely to their specific workflow data and integrations. We worry that if OpenAI or Anthropic releases more specialized 'insurance-tuned' models, the proprietary value of Avallon's current agentic layer might diminish.","sales_cycle_fatigue":"While TPAs are a great entry point, the real volume is in the major carriers. These companies have 18–24 month sales cycles. We are hesitant to invest in a business that could face a significant 'revenue plateau' while waiting for enterprise-scale approvals."},"critical_assumptions":[{"assumption_type":"pass_rationale","assumption_text":"Market Saturation","must_be_true":"The 'AI Agent' field is currently the most crowded sector in venture capital. We see hundreds of companies building 'AI for Insurance,' and we are concerned that Avallon may struggle to maintain its 10x growth once incumbents like Salesforce and Guidewire release their own native agentic features.","failure_mode":"The 'AI Agent' field is currently the most crowded sector in venture capital. We see hundreds of companies building 'AI for Insurance,' and we are concerned that Avallon may struggle to maintain its 10x growth once incumbents like Salesforce and Guidewire release their own native agentic features.","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"Integration Longevity","must_be_true":"The insurance industry is notorious for 'Integration Hell.' While Avallon has succeeded with smaller TPAs, the technical debt required to integrate with the bespoke legacy systems of top-tier carriers (like State Farm or Geico) may slow their scaling velocity and hurt long-term margins.","failure_mode":"The insurance industry is notorious for 'Integration Hell.' While Avallon has succeeded with smaller TPAs, the technical debt required to integrate with the bespoke legacy systems of top-tier carriers (like State Farm or Geico) may slow their scaling velocity and hurt long-term margins.","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"Liability Tail Risk","must_be_true":"Insurance claims involve high financial and legal stakes. A single 'hallucination' where an AI agent misinterprets a policy term or incorrectly accepts liability could result in massive lawsuits. We aren't yet convinced that the 'Human-in-the-Loop' safeguards are robust enough to mitigate this systemic risk.","failure_mode":"Insurance claims involve high financial and legal stakes. A single 'hallucination' where an AI agent misinterprets a policy term or incorrectly accepts liability could result in massive lawsuits. We aren't yet convinced that the 'Human-in-the-Loop' safeguards are robust enough to mitigate this systemic risk.","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"Moat Defensibility","must_be_true":"As LLM capabilities become commoditized, the 'moat' for Avallon shifts entirely to their specific workflow data and integrations. We worry that if OpenAI or Anthropic releases more specialized 'insurance-tuned' models, the proprietary value of Avallon's current agentic layer might diminish.","failure_mode":"As LLM capabilities become commoditized, the 'moat' for Avallon shifts entirely to their specific workflow data and integrations. We worry that if OpenAI or Anthropic releases more specialized 'insurance-tuned' models, the proprietary value of Avallon's current agentic layer might diminish.","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"Sales Cycle Fatigue","must_be_true":"While TPAs are a great entry point, the real volume is in the major carriers. These companies have 18–24 month sales cycles. We are hesitant to invest in a business that could face a significant 'revenue plateau' while waiting for enterprise-scale approvals.","failure_mode":"While TPAs are a great entry point, the real volume is in the major carriers. These companies have 18–24 month sales cycles. We are hesitant to invest in a business that could face a significant 'revenue plateau' while waiting for enterprise-scale approvals.","is_linchpin":false}]}$j$::jsonb
);

INSERT INTO public.deal_problem (
  deal_id, analysis_id,
  problem_statement, root_cause_depth, economic_gravity, structural_urgency,
  persona_clarity, economic_buyer_persona, budget_priority_validation,
  stated_problem_ref, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  '1b000000-0000-4000-8000-000000000008'::uuid,
  'The insurance claims industry is facing a massive ''labor cliff'' where adjusters are retiring faster than they can be replaced, leading to service delays and burnout.

Barriers:
1. Fragmented Communication: Adjusters spend 60% of their time on ''phone tag'' and routine status updates.
2. Unstructured Data: Sifting through thousands of PDFs, medical bills, and photos manually is slow and error-prone.
3. Legacy Systems: Most carriers use 20-year-old Claims Management Systems (CMS) that lack modern automation capabilities.',
  'Fragmented Communication: Adjusters spend 60% of their time on ''phone tag'' and routine status updates.',
  'Economic impact implied by: Fragmented Communication: Adjusters spend 60% of their time on ''phone tag'' and routine status updates. Unstructured Data: Sifting through thousands of PDFs, medical bills, and photos manually is slow and error-prone.',
  '1. Fragmented Communication: Adjusters spend 60% of their time on ''phone tag'' and routine status updates.
2. Unstructured Data: Sifting through thousands of PDFs, medical bills, and photos manually is slow and error-prone.
3. Legacy Systems: Most carriers use 20-year-old Claims Management Systems (CMS) that lack modern automation capabilities.',
  'Enterprise / regulated financial buyer',
  'Enterprise / regulated financial buyer',
  NULL,
  'The insurance claims industry is facing a massive ''labor cliff'' where adjusters are retiring faster than they can be replaced, leading to service delays and burnout.',
  'historical_seed'
);

INSERT INTO public.deal_solution (
  deal_id, analysis_id,
  solution_summary, product_type, moat_type, replication_difficulty, compounding_potential,
  technical_moat_evidence, differentiation_proof_points, competitor_landscape_json, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  '1b000000-0000-4000-8000-000000000008'::uuid,
  'AI-Native Claims Operations Platform

Transforming claims from a manual cost center into a high-speed, automated operation that allows human adjusters to focus on high-stakes decision-making.',
  'AI-Native Claims Operations Platform',
  'network + integrations',
  'High replication cost: Multimodal AI Agents: Autonomous agents that handle phone calls (intake/status), email triage, and document parsing (extracting data from medical reports).; End-to-End Orchestration: Moves a claim from initial report to settlement without requiring manual data entry at every step.',
  'Compounding via: Transforming claims from a manual cost center into a high-speed, automated operation that allows human adjusters to focus on high-stakes decision-making.',
  'Multimodal AI Agents: Autonomous agents that handle phone calls (intake/status), email triage, and document parsing (extracting data from medical reports).
End-to-End Orchestration: Moves a claim from initial report to settlement without requiring manual data entry at every step.
Write-Back Integration: Plugs directly into legacy CMS platforms to keep records updated in real-time.
Liability Copilot: Analyzes policy terms and flags potential exposures for adjusters to review, ensuring consistency in decisions.',
  $j$["Multimodal AI Agents: Autonomous agents that handle phone calls (intake/status), email triage, and document parsing (extracting data from medical reports).","End-to-End Orchestration: Moves a claim from initial report to settlement without requiring manual data entry at every step.","Write-Back Integration: Plugs directly into legacy CMS platforms to keep records updated in real-time.","Liability Copilot: Analyzes policy terms and flags potential exposures for adjusters to review, ensuring consistency in decisions."]$j$::jsonb,
  $j$[{"name":"Salesforce","category":"incumbent / alternative","note":"Referenced in source narrative"},{"name":"Guidewire","category":"incumbent / alternative","note":"Referenced in source narrative"},{"name":"State Farm","category":"incumbent / alternative","note":"Referenced in source narrative"},{"name":"Geico","category":"incumbent / alternative","note":"Referenced in source narrative"},{"name":"OpenAI","category":"incumbent / alternative","note":"Referenced in source narrative"},{"name":"Anthropic","category":"incumbent / alternative","note":"Referenced in source narrative"}]$j$::jsonb,
  'historical_seed'
);

INSERT INTO public.deal_traction (
  deal_id, analysis_id,
  traction_evidence_json, phase1_traction_json, milestones_detected,
  inferred_stage, benchmark_context, revenue_data, growth_signals, customer_depth, user_traction,
  notable_partners_and_validation, investor_list, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  '1b000000-0000-4000-8000-000000000008'::uuid,
  $j${"funding":{"total_funding":"$5.1 Million","latest_round":"$4.6 Million Seed (November 2025)","lead_investor":"Frontline Ventures","participating_investors":["Y Combinator (Spring 2025 Batch)","1984 Ventures","Liquid 2 Ventures","Booom Ventures"]},"business_metrics":["Achieved 10x revenue growth during the 3-month Y Combinator period.","Secured major contracts with Third-Party Administrators (TPAs) including Athens Administrators.","Live with multiple partners managing over 400 adjusters and thousands of claims.","Reported cutting claims processing time by up to 90% for pilot customers."]}$j$::jsonb,
  $j${"funding":{"total_funding":"$5.1 Million","latest_round":"$4.6 Million Seed (November 2025)","lead_investor":"Frontline Ventures","participating_investors":["Y Combinator (Spring 2025 Batch)","1984 Ventures","Liquid 2 Ventures","Booom Ventures"]},"business_metrics":["Achieved 10x revenue growth during the 3-month Y Combinator period.","Secured major contracts with Third-Party Administrators (TPAs) including Athens Administrators.","Live with multiple partners managing over 400 adjusters and thousands of claims.","Reported cutting claims processing time by up to 90% for pilot customers."]}$j$::jsonb,
  $j$["Achieved 10x revenue growth during the 3-month Y Combinator period.","Secured major contracts with Third-Party Administrators (TPAs) including Athens Administrators.","Live with multiple partners managing over 400 adjusters and thousands of claims.","Reported cutting claims processing time by up to 90% for pilot customers."]$j$::jsonb,
  'Founded 2025',
  'HQ: New York, NY | Founded: 2025 | Round: $4.6 Million Seed (November 2025)',
  'Achieved 10x revenue growth during the 3-month Y Combinator period.
Secured major contracts with Third-Party Administrators (TPAs) including Athens Administrators.',
  'Achieved 10x revenue growth during the 3-month Y Combinator period.',
  'Live with multiple partners managing over 400 adjusters and thousands of claims.
Reported cutting claims processing time by up to 90% for pilot customers.',
  'Secured major contracts with Third-Party Administrators (TPAs) including Athens Administrators.',
  $j$["Achieved 10x revenue growth during the 3-month Y Combinator period.","Secured major contracts with Third-Party Administrators (TPAs) including Athens Administrators.","Live with multiple partners managing over 400 adjusters and thousands of claims.","Reported cutting claims processing time by up to 90% for pilot customers."]$j$::jsonb,
  $j$[{"name":"Frontline Ventures","role":"lead"},{"name":"Y Combinator (Spring 2025 Batch)","role":"participant"},{"name":"1984 Ventures","role":"participant"},{"name":"Liquid 2 Ventures","role":"participant"},{"name":"Booom Ventures","role":"participant"}]$j$::jsonb,
  'historical_seed'
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  'founded_year',
  '2025',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  'headquarters',
  'New York, NY',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  'total_funding',
  '$5.1 Million',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  'latest_round',
  '$4.6 Million Seed (November 2025)',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  'traction_highlight_1',
  'Achieved 10x revenue growth during the 3-month Y Combinator period.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  'traction_highlight_2',
  'Secured major contracts with Third-Party Administrators (TPAs) including Athens Administrators.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  'traction_highlight_3',
  'Live with multiple partners managing over 400 adjusters and thousands of claims.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  'traction_highlight_4',
  'Reported cutting claims processing time by up to 90% for pilot customers.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  '1b000000-0000-4000-8000-000000000008'::uuid,
  'Salesforce',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  '1b000000-0000-4000-8000-000000000008'::uuid,
  'Guidewire',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  '1b000000-0000-4000-8000-000000000008'::uuid,
  'State Farm',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  '1b000000-0000-4000-8000-000000000008'::uuid,
  'Geico',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  '1b000000-0000-4000-8000-000000000008'::uuid,
  'OpenAI',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  '1b000000-0000-4000-8000-000000000008'::uuid,
  'Anthropic',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  '5bd44c84-f823-491e-ac8b-96b1ed7b80a3'::uuid,
  'lead',
  '$4.6 Million Seed (November 2025)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  '9ef4a888-745e-4fb1-a0af-951d2b3f738b'::uuid,
  'participant',
  '$4.6 Million Seed (November 2025)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  '32d9d30b-54d5-482d-aba0-f9bf43363bc1'::uuid,
  'participant',
  '$4.6 Million Seed (November 2025)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  '324e548d-34cd-4cf5-ac56-1127387c0eb0'::uuid,
  'participant',
  '$4.6 Million Seed (November 2025)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  '0dbd595f-e16d-4339-aea4-47f65fad9299'::uuid,
  'participant',
  '$4.6 Million Seed (November 2025)',
  NULL
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  '1b000000-0000-4000-8000-000000000008'::uuid,
  'Market Saturation',
  'pass_rationale',
  NULL,
  'The ''AI Agent'' field is currently the most crowded sector in venture capital. We see hundreds of companies building ''AI for Insurance,'' and we are concerned that Avallon may struggle to maintain its 10x growth once incumbents like Salesforce and Guidewire release their own native agentic features.',
  false,
  NULL,
  NULL,
  'The ''AI Agent'' field is currently the most crowded sector in venture capital. We see hundreds of companies building ''AI for Insurance,'' and we are concerned that Avallon may struggle to maintain its 10x growth once incumbents like Salesforce and Guidewire release their own native agentic features.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  '1b000000-0000-4000-8000-000000000008'::uuid,
  'Integration Longevity',
  'pass_rationale',
  NULL,
  'The insurance industry is notorious for ''Integration Hell.'' While Avallon has succeeded with smaller TPAs, the technical debt required to integrate with the bespoke legacy systems of top-tier carriers (like State Farm or Geico) may slow their scaling velocity and hurt long-term margins.',
  false,
  NULL,
  NULL,
  'The insurance industry is notorious for ''Integration Hell.'' While Avallon has succeeded with smaller TPAs, the technical debt required to integrate with the bespoke legacy systems of top-tier carriers (like State Farm or Geico) may slow their scaling velocity and hurt long-term margins.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  '1b000000-0000-4000-8000-000000000008'::uuid,
  'Liability Tail Risk',
  'pass_rationale',
  NULL,
  'Insurance claims involve high financial and legal stakes. A single ''hallucination'' where an AI agent misinterprets a policy term or incorrectly accepts liability could result in massive lawsuits. We aren''t yet convinced that the ''Human-in-the-Loop'' safeguards are robust enough to mitigate this systemic risk.',
  false,
  NULL,
  NULL,
  'Insurance claims involve high financial and legal stakes. A single ''hallucination'' where an AI agent misinterprets a policy term or incorrectly accepts liability could result in massive lawsuits. We aren''t yet convinced that the ''Human-in-the-Loop'' safeguards are robust enough to mitigate this systemic risk.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  '1b000000-0000-4000-8000-000000000008'::uuid,
  'Moat Defensibility',
  'pass_rationale',
  NULL,
  'As LLM capabilities become commoditized, the ''moat'' for Avallon shifts entirely to their specific workflow data and integrations. We worry that if OpenAI or Anthropic releases more specialized ''insurance-tuned'' models, the proprietary value of Avallon''s current agentic layer might diminish.',
  false,
  NULL,
  NULL,
  'As LLM capabilities become commoditized, the ''moat'' for Avallon shifts entirely to their specific workflow data and integrations. We worry that if OpenAI or Anthropic releases more specialized ''insurance-tuned'' models, the proprietary value of Avallon''s current agentic layer might diminish.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  '1b000000-0000-4000-8000-000000000008'::uuid,
  'Sales Cycle Fatigue',
  'pass_rationale',
  NULL,
  'While TPAs are a great entry point, the real volume is in the major carriers. These companies have 18–24 month sales cycles. We are hesitant to invest in a business that could face a significant ''revenue plateau'' while waiting for enterprise-scale approvals.',
  false,
  NULL,
  NULL,
  'While TPAs are a great entry point, the real volume is in the major carriers. These companies have 18–24 month sales cycles. We are hesitant to invest in a business that could face a significant ''revenue plateau'' while waiting for enterprise-scale approvals.'
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  'Cornelius Schramm',
  'Co-founder & CEO',
  'Founding U.S. engineer at FINN (built operations for $15M ARR); experienced in scaling fleet operations.',
  NULL,
  'YC (Spring 2025',
  NULL,
  $j$["FINN (built operations for $15M ARR"]$j$::jsonb,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Cornelius Schramm","role":"Co-founder & CEO","background":"Founding U.S. engineer at FINN (built operations for $15M ARR); experienced in scaling fleet operations."}$j$::jsonb
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  'Bryan Guin',
  'Co-founder & COO',
  'Former product leader at EY (consulting for Fortune 500s); ML researcher at Cornell.',
  ARRAY['Cornell']::text[],
  'YC (Spring 2025',
  $j$["EY (consulting for Fortune 500s)"]$j$::jsonb,
  $j$["Cornell","EY (consulting for Fortune 500s"]$j$::jsonb,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Bryan Guin","role":"Co-founder & COO","background":"Former product leader at EY (consulting for Fortune 500s); ML researcher at Cornell."}$j$::jsonb
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000008'::uuid,
  'Jet Semrick',
  'Co-founder & CTO',
  'Specialist in quantitative trading algorithms; national champion policy debater.',
  NULL,
  'YC (Spring 2025',
  NULL,
  NULL,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Jet Semrick","role":"Co-founder & CTO","background":"Specialist in quantitative trading algorithms; national champion policy debater."}$j$::jsonb
);

INSERT INTO public.deals (id, user_id, company_name, geography, decision, source, pass_reason, pass_reason_detail)
VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  'REPLACE_WITH_YOUR_USER_UUID'::uuid,
  'Zavo',
  'San Francisco, CA & London, UK',
  'passed',
  'invested-companies-md',
  'hypothetical_rejection',
  '{"incumbent_dominance":"The restaurant POS market is a ''Red Ocean'' dominated by multi-billion dollar giants like Toast, Clover, and Square. These incumbents have massive distribution networks and ''boots on the ground'' sales teams that a small startup like Zavo will struggle to match without enormous capital expenditure.","low-margin_vulnerability":"Zavo’s primary hook is lower transaction fees (0.79%). While attractive for acquisition, this creates a ''race to the bottom'' on margins, leaving very little room for the high R&D costs associated with maintaining advanced AI agents.","the_ai-wrapper_risk":"Many of Zavo''s core innovations (AI voice agents and automated marketing) are features that incumbents can—and likely will—integrate directly into their existing platforms. Once Toast or Square launches a native ''AI Reservationist,'' Zavo loses its primary differentiation.","high-churn_vertical":"The small restaurant sector has a notoriously high failure rate. Investing in a company whose growth is tied to the survival of SMB hospitality businesses introduces significant systemic risk, especially in a volatile 2026 economic environment.","compliance_and_operational_friction":"Customer reviews already highlight ''frozen funds'' and compliance delays. For a payment-centric business, any friction in money movement is a death knell for trust, suggesting that their internal infrastructure may not yet be ready for rapid scale."}'
);

INSERT INTO public.deal_analyses (id, deal_id, pipeline_version, raw_output)
VALUES (
  '1b000000-0000-4000-8000-000000000009'::uuid,
  '1a000000-0000-4000-8000-000000000009'::uuid,
  2,
  $j${"company_name":"Zavo","founded_year":2025,"headquarters":"San Francisco, CA & London, UK","founders":[{"name":"Can Zehebi","role":"Co-founder & CEO","background":"Serial entrepreneur with a focus on fintech and payment infrastructure."},{"name":"Ilkan Gezer","role":"Co-founder & CTO","background":"Engineer specialized in building unified payment stacks and agentic AI systems."}],"founding_team":{"size":8,"key_expertise":"The team consists of experts in full-stack restaurant technology, payment processing, and conversational AI (voice agents)."},"traction":{"funding":{"total_funding":"$500,000+","latest_round":"Y Combinator (Winter 2026 / Fall 2025)","lead_investor":"Y Combinator"},"business_metrics":["Over 400 businesses (restaurants and retail shops) onboarded within the first 6 months of operation.","Achieved 11+ hours saved per week on reconciliation for early adopters.","Reports a 32% increase in captured reservations for clients using their AI voice agents.","Standardized transaction fee of 0.79%, positioning themselves as the low-cost leader compared to Square and SumUp."]},"problem_statement":{"core_issue":"Small and medium-sized restaurants are currently forced to manage a 'chaos stack' of disconnected tools.","barriers":["Fragmented Systems: Separate providers for POS, reservations, payments, and marketing that do not communicate.","Administrative Burden: Owners spend hours on manual reconciliation, menu updates, and staff scheduling.","Missed Revenue: Inefficient reservation systems lead to missed calls and empty tables during peak hours."]},"solution":{"primary_product":"AI-Native Operating System for Hospitality","key_features":["Unified POS & Payments: A single platform for in-person card terminals, online ordering, and Tap to Pay.","Zavo Voice Agents: AI agents that answer the phone, handle reservations, and answer customer queries autonomously.","Agentic Menu Management: AI that allows staff to make instant menu edits or inventory queries via voice/text.","Automated Marketing: AI-driven loyalty campaigns that trigger based on customer spending patterns without manual input."],"value_proposition":"Giving every independent restaurant its own 'digital workforce' to handle the admin and operations, allowing owners to focus entirely on the guest experience."},"hypothetical_investment_rejection_reasoning":{"incumbent_dominance":"The restaurant POS market is a 'Red Ocean' dominated by multi-billion dollar giants like Toast, Clover, and Square. These incumbents have massive distribution networks and 'boots on the ground' sales teams that a small startup like Zavo will struggle to match without enormous capital expenditure.","low-margin_vulnerability":"Zavo’s primary hook is lower transaction fees (0.79%). While attractive for acquisition, this creates a 'race to the bottom' on margins, leaving very little room for the high R&D costs associated with maintaining advanced AI agents.","the_ai-wrapper_risk":"Many of Zavo's core innovations (AI voice agents and automated marketing) are features that incumbents can—and likely will—integrate directly into their existing platforms. Once Toast or Square launches a native 'AI Reservationist,' Zavo loses its primary differentiation.","high-churn_vertical":"The small restaurant sector has a notoriously high failure rate. Investing in a company whose growth is tied to the survival of SMB hospitality businesses introduces significant systemic risk, especially in a volatile 2026 economic environment.","compliance_and_operational_friction":"Customer reviews already highlight 'frozen funds' and compliance delays. For a payment-centric business, any friction in money movement is a death knell for trust, suggesting that their internal infrastructure may not yet be ready for rapid scale."},"critical_assumptions":[{"assumption_type":"pass_rationale","assumption_text":"Incumbent Dominance","must_be_true":"The restaurant POS market is a 'Red Ocean' dominated by multi-billion dollar giants like Toast, Clover, and Square. These incumbents have massive distribution networks and 'boots on the ground' sales teams that a small startup like Zavo will struggle to match without enormous capital expenditure.","failure_mode":"The restaurant POS market is a 'Red Ocean' dominated by multi-billion dollar giants like Toast, Clover, and Square. These incumbents have massive distribution networks and 'boots on the ground' sales teams that a small startup like Zavo will struggle to match without enormous capital expenditure.","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"Low-Margin Vulnerability","must_be_true":"Zavo’s primary hook is lower transaction fees (0.79%). While attractive for acquisition, this creates a 'race to the bottom' on margins, leaving very little room for the high R&D costs associated with maintaining advanced AI agents.","failure_mode":"Zavo’s primary hook is lower transaction fees (0.79%). While attractive for acquisition, this creates a 'race to the bottom' on margins, leaving very little room for the high R&D costs associated with maintaining advanced AI agents.","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"The Ai-Wrapper Risk","must_be_true":"Many of Zavo's core innovations (AI voice agents and automated marketing) are features that incumbents can—and likely will—integrate directly into their existing platforms. Once Toast or Square launches a native 'AI Reservationist,' Zavo loses its primary differentiation.","failure_mode":"Many of Zavo's core innovations (AI voice agents and automated marketing) are features that incumbents can—and likely will—integrate directly into their existing platforms. Once Toast or Square launches a native 'AI Reservationist,' Zavo loses its primary differentiation.","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"High-Churn Vertical","must_be_true":"The small restaurant sector has a notoriously high failure rate. Investing in a company whose growth is tied to the survival of SMB hospitality businesses introduces significant systemic risk, especially in a volatile 2026 economic environment.","failure_mode":"The small restaurant sector has a notoriously high failure rate. Investing in a company whose growth is tied to the survival of SMB hospitality businesses introduces significant systemic risk, especially in a volatile 2026 economic environment.","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"Compliance And Operational Friction","must_be_true":"Customer reviews already highlight 'frozen funds' and compliance delays. For a payment-centric business, any friction in money movement is a death knell for trust, suggesting that their internal infrastructure may not yet be ready for rapid scale.","failure_mode":"Customer reviews already highlight 'frozen funds' and compliance delays. For a payment-centric business, any friction in money movement is a death knell for trust, suggesting that their internal infrastructure may not yet be ready for rapid scale.","is_linchpin":false}]}$j$::jsonb
);

INSERT INTO public.deal_problem (
  deal_id, analysis_id,
  problem_statement, root_cause_depth, economic_gravity, structural_urgency,
  persona_clarity, economic_buyer_persona, budget_priority_validation,
  stated_problem_ref, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  '1b000000-0000-4000-8000-000000000009'::uuid,
  'Small and medium-sized restaurants are currently forced to manage a ''chaos stack'' of disconnected tools.

Barriers:
1. Fragmented Systems: Separate providers for POS, reservations, payments, and marketing that do not communicate.
2. Administrative Burden: Owners spend hours on manual reconciliation, menu updates, and staff scheduling.
3. Missed Revenue: Inefficient reservation systems lead to missed calls and empty tables during peak hours.',
  'Fragmented Systems: Separate providers for POS, reservations, payments, and marketing that do not communicate.',
  'Economic impact implied by: Fragmented Systems: Separate providers for POS, reservations, payments, and marketing that do not communicate. Administrative Burden: Owners spend hours on manual reconciliation, menu updates, and staff scheduling.',
  '1. Fragmented Systems: Separate providers for POS, reservations, payments, and marketing that do not communicate.
2. Administrative Burden: Owners spend hours on manual reconciliation, menu updates, and staff scheduling.
3. Missed Revenue: Inefficient reservation systems lead to missed calls and empty tables during peak hours.',
  'SMB / operator buyer',
  'SMB / operator buyer',
  'Fragmented Systems: Separate providers for POS, reservations, payments, and marketing that do not communicate.',
  'Small and medium-sized restaurants are currently forced to manage a ''chaos stack'' of disconnected tools.',
  'historical_seed'
);

INSERT INTO public.deal_solution (
  deal_id, analysis_id,
  solution_summary, product_type, moat_type, replication_difficulty, compounding_potential,
  technical_moat_evidence, differentiation_proof_points, competitor_landscape_json, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  '1b000000-0000-4000-8000-000000000009'::uuid,
  'AI-Native Operating System for Hospitality

Giving every independent restaurant its own ''digital workforce'' to handle the admin and operations, allowing owners to focus entirely on the guest experience.',
  'AI-Native Operating System for Hospitality',
  'technical / data',
  'High replication cost: Unified POS & Payments: A single platform for in-person card terminals, online ordering, and Tap to Pay.; Zavo Voice Agents: AI agents that answer the phone, handle reservations, and answer customer queries autonomously.',
  'Compounding via: Giving every independent restaurant its own ''digital workforce'' to handle the admin and operations, allowing owners to focus entirely on the guest experience.',
  'Unified POS & Payments: A single platform for in-person card terminals, online ordering, and Tap to Pay.
Zavo Voice Agents: AI agents that answer the phone, handle reservations, and answer customer queries autonomously.
Agentic Menu Management: AI that allows staff to make instant menu edits or inventory queries via voice/text.
Automated Marketing: AI-driven loyalty campaigns that trigger based on customer spending patterns without manual input.',
  $j$["Unified POS & Payments: A single platform for in-person card terminals, online ordering, and Tap to Pay.","Zavo Voice Agents: AI agents that answer the phone, handle reservations, and answer customer queries autonomously.","Agentic Menu Management: AI that allows staff to make instant menu edits or inventory queries via voice/text.","Automated Marketing: AI-driven loyalty campaigns that trigger based on customer spending patterns without manual input."]$j$::jsonb,
  $j$[{"name":"Toast","category":"incumbent / alternative","note":"Referenced in source narrative"},{"name":"Square","category":"incumbent / alternative","note":"Referenced in source narrative"},{"name":"Clover","category":"incumbent / alternative","note":"Referenced in source narrative"}]$j$::jsonb,
  'historical_seed'
);

INSERT INTO public.deal_traction (
  deal_id, analysis_id,
  traction_evidence_json, phase1_traction_json, milestones_detected,
  inferred_stage, benchmark_context, revenue_data, growth_signals, customer_depth, user_traction,
  notable_partners_and_validation, investor_list, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  '1b000000-0000-4000-8000-000000000009'::uuid,
  $j${"funding":{"total_funding":"$500,000+","latest_round":"Y Combinator (Winter 2026 / Fall 2025)","lead_investor":"Y Combinator"},"business_metrics":["Over 400 businesses (restaurants and retail shops) onboarded within the first 6 months of operation.","Achieved 11+ hours saved per week on reconciliation for early adopters.","Reports a 32% increase in captured reservations for clients using their AI voice agents.","Standardized transaction fee of 0.79%, positioning themselves as the low-cost leader compared to Square and SumUp."]}$j$::jsonb,
  $j${"funding":{"total_funding":"$500,000+","latest_round":"Y Combinator (Winter 2026 / Fall 2025)","lead_investor":"Y Combinator"},"business_metrics":["Over 400 businesses (restaurants and retail shops) onboarded within the first 6 months of operation.","Achieved 11+ hours saved per week on reconciliation for early adopters.","Reports a 32% increase in captured reservations for clients using their AI voice agents.","Standardized transaction fee of 0.79%, positioning themselves as the low-cost leader compared to Square and SumUp."]}$j$::jsonb,
  $j$["Over 400 businesses (restaurants and retail shops) onboarded within the first 6 months of operation.","Achieved 11+ hours saved per week on reconciliation for early adopters.","Reports a 32% increase in captured reservations for clients using their AI voice agents.","Standardized transaction fee of 0.79%, positioning themselves as the low-cost leader compared to Square and SumUp."]$j$::jsonb,
  'Founded 2025',
  'HQ: San Francisco, CA & London, UK | Founded: 2025 | Round: Y Combinator (Winter 2026 / Fall 2025)',
  NULL,
  'Reports a 32% increase in captured reservations for clients using their AI voice agents.',
  'Over 400 businesses (restaurants and retail shops) onboarded within the first 6 months of operation.',
  NULL,
  $j$["Over 400 businesses (restaurants and retail shops) onboarded within the first 6 months of operation.","Achieved 11+ hours saved per week on reconciliation for early adopters.","Reports a 32% increase in captured reservations for clients using their AI voice agents.","Standardized transaction fee of 0.79%, positioning themselves as the low-cost leader compared to Square and SumUp."]$j$::jsonb,
  $j$[{"name":"Y Combinator","role":"lead"}]$j$::jsonb,
  'historical_seed'
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  'founded_year',
  '2025',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  'headquarters',
  'San Francisco, CA & London, UK',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  'total_funding',
  '$500,000+',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  'latest_round',
  'Y Combinator (Winter 2026 / Fall 2025)',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  'traction_highlight_1',
  'Over 400 businesses (restaurants and retail shops) onboarded within the first 6 months of operation.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  'traction_highlight_2',
  'Achieved 11+ hours saved per week on reconciliation for early adopters.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  'traction_highlight_3',
  'Reports a 32% increase in captured reservations for clients using their AI voice agents.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  'traction_highlight_4',
  'Standardized transaction fee of 0.79%, positioning themselves as the low-cost leader compared to Square and SumUp.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  '1b000000-0000-4000-8000-000000000009'::uuid,
  'Toast',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  '1b000000-0000-4000-8000-000000000009'::uuid,
  'Square',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  '1b000000-0000-4000-8000-000000000009'::uuid,
  'Clover',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  '6d8c434a-d078-46a9-af0f-a7107f271f90'::uuid,
  'lead',
  'Y Combinator (Winter 2026 / Fall 2025)',
  NULL
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  '1b000000-0000-4000-8000-000000000009'::uuid,
  'Incumbent Dominance',
  'pass_rationale',
  NULL,
  'The restaurant POS market is a ''Red Ocean'' dominated by multi-billion dollar giants like Toast, Clover, and Square. These incumbents have massive distribution networks and ''boots on the ground'' sales teams that a small startup like Zavo will struggle to match without enormous capital expenditure.',
  false,
  NULL,
  NULL,
  'The restaurant POS market is a ''Red Ocean'' dominated by multi-billion dollar giants like Toast, Clover, and Square. These incumbents have massive distribution networks and ''boots on the ground'' sales teams that a small startup like Zavo will struggle to match without enormous capital expenditure.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  '1b000000-0000-4000-8000-000000000009'::uuid,
  'Low-Margin Vulnerability',
  'pass_rationale',
  NULL,
  'Zavo’s primary hook is lower transaction fees (0.79%). While attractive for acquisition, this creates a ''race to the bottom'' on margins, leaving very little room for the high R&D costs associated with maintaining advanced AI agents.',
  false,
  NULL,
  NULL,
  'Zavo’s primary hook is lower transaction fees (0.79%). While attractive for acquisition, this creates a ''race to the bottom'' on margins, leaving very little room for the high R&D costs associated with maintaining advanced AI agents.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  '1b000000-0000-4000-8000-000000000009'::uuid,
  'The Ai-Wrapper Risk',
  'pass_rationale',
  NULL,
  'Many of Zavo''s core innovations (AI voice agents and automated marketing) are features that incumbents can—and likely will—integrate directly into their existing platforms. Once Toast or Square launches a native ''AI Reservationist,'' Zavo loses its primary differentiation.',
  false,
  NULL,
  NULL,
  'Many of Zavo''s core innovations (AI voice agents and automated marketing) are features that incumbents can—and likely will—integrate directly into their existing platforms. Once Toast or Square launches a native ''AI Reservationist,'' Zavo loses its primary differentiation.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  '1b000000-0000-4000-8000-000000000009'::uuid,
  'High-Churn Vertical',
  'pass_rationale',
  NULL,
  'The small restaurant sector has a notoriously high failure rate. Investing in a company whose growth is tied to the survival of SMB hospitality businesses introduces significant systemic risk, especially in a volatile 2026 economic environment.',
  false,
  NULL,
  NULL,
  'The small restaurant sector has a notoriously high failure rate. Investing in a company whose growth is tied to the survival of SMB hospitality businesses introduces significant systemic risk, especially in a volatile 2026 economic environment.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  '1b000000-0000-4000-8000-000000000009'::uuid,
  'Compliance And Operational Friction',
  'pass_rationale',
  NULL,
  'Customer reviews already highlight ''frozen funds'' and compliance delays. For a payment-centric business, any friction in money movement is a death knell for trust, suggesting that their internal infrastructure may not yet be ready for rapid scale.',
  false,
  NULL,
  NULL,
  'Customer reviews already highlight ''frozen funds'' and compliance delays. For a payment-centric business, any friction in money movement is a death knell for trust, suggesting that their internal infrastructure may not yet be ready for rapid scale.'
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  'Can Zehebi',
  'Co-founder & CEO',
  'Serial entrepreneur with a focus on fintech and payment infrastructure.',
  NULL,
  'YC (Winter 2026',
  NULL,
  NULL,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Can Zehebi","role":"Co-founder & CEO","background":"Serial entrepreneur with a focus on fintech and payment infrastructure."}$j$::jsonb
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-000000000009'::uuid,
  'Ilkan Gezer',
  'Co-founder & CTO',
  'Engineer specialized in building unified payment stacks and agentic AI systems.',
  NULL,
  'YC (Winter 2026',
  NULL,
  NULL,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Ilkan Gezer","role":"Co-founder & CTO","background":"Engineer specialized in building unified payment stacks and agentic AI systems."}$j$::jsonb
);

INSERT INTO public.deals (id, user_id, company_name, geography, decision, source, pass_reason, pass_reason_detail)
VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  'REPLACE_WITH_YOUR_USER_UUID'::uuid,
  'Selfin',
  'San Francisco, CA & London, UK',
  'passed',
  'invested-companies-md',
  'hypothetical_rejection',
  '{"trust_and_delegation_risk":"The ''Agency Gap'': Selfin’s success requires users to delegate actual movement of funds to an AI. While technically feasible, the psychological barrier to letting an algorithm handle a life savings is massive. We are concerned the ''trust cycle'' for this product will be too long for venture-scale growth in the near term.","the_aggregator_dependency":"The platform is entirely dependent on the stability of third-party APIs (like Plaid). If major banks decide to block these ''agentic'' aggregators to protect their own ecosystems, Selfin’s core value proposition disappears. We prefer to invest in companies that own the underlying ledger.","incumbent_sherlocking":"Massive neobanks like Revolut and Chime have the same data and much larger engineering budgets. We believe they will ''Sherlock'' Selfin’s features—integrating similar AI agents directly into their apps—before Selfin can acquire a defensive number of users.","regulatory_headwinds":"An ''AI-native bank'' that makes autonomous financial decisions for consumers is a prime target for the CFPB. The potential for ''algorithmic bias'' in lending or automated advice could lead to crippling legal and compliance costs that a seed-stage team is ill-equipped to handle.","low-retention_utility":"There is a risk that this is a ''set-it-and-forget-it'' tool. Once the AI optimizes the user''s accounts, there may be little reason for the user to return to the app daily, making it difficult to build a high-engagement platform or a successful secondary marketplace for financial products."}'
);

INSERT INTO public.deal_analyses (id, deal_id, pipeline_version, raw_output)
VALUES (
  '1b000000-0000-4000-8000-00000000000a'::uuid,
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  2,
  $j${"company_name":"Selfin","founded_year":2025,"headquarters":"San Francisco, CA & London, UK","founders":[{"name":"Paula Gutierrez","role":"Co-founder & CEO","background":"Aerospace Engineering (Imperial/MIT/Berkeley); former Quantitative Analyst at Bank of America and researcher at NASA and Rolls-Royce."},{"name":"Joel Tomas Pimentel","role":"Co-founder & CTO","background":"Aerospace Engineering (Imperial/Stanford); former consultant at BCG; specialized in complex engineering and 'rocket science' systems."}],"founding_team":{"size":"Estimated 2-7 employees","key_expertise":"The team combines elite aerospace engineering (MIT/Stanford) with high-level quantitative finance and strategic consulting backgrounds, specifically focused on AI-driven financial modeling."},"traction":{"funding":{"total_funding":"$7.0 Million","latest_round":"Seed Round (Post-YC F25)","lead_investors":["Y Combinator","Ripple Impact Investments","Transpose Platform Management"]},"milestones":["Member of the Y Combinator Fall 2025 batch.","Grew a massive waitlist for their 'First AI Bank' concept during the YC period.","Integrated with major financial data aggregators to support a unified view of 401ks, crypto, and traditional banking.","Successfully launched an AI-powered assistant that automates cross-account financial optimizations for early beta users."]},"problem_statement":{"core_issue":"Personal finance is 'fragmented and painful,' with assets scattered across dozens of apps that don't communicate, leading to missed wealth-building opportunities.","barriers":["Decision Overload: Users struggle to manually decide between paying off debt, funding a 401k, or moving money to high-yield savings.","Siloed Data: Banks only see a fraction of a user's financial life, resulting in generic, disconnected advice.","Administrative Burden: Managing wealth effectively currently requires spreadsheets and hours of manual research that most people avoid."]},"solution":{"primary_product":"AI-Native Neobank & Financial Assistant","key_features":["Full-Context Banking: Connects all financial products—credit, investments, crypto, 401ks, and savings—into one intelligent interface.","Autonomous Financial Agents: AI agents that 'act' for you, such as automatically moving idle cash into the highest-yielding verified account.","Personalized Optimizations: Real-time alerts and automated actions to reduce fees and capture better interest rates based on your entire net worth.","Generative Intelligence: A conversational 'financial brain' that answers complex questions like 'Can I afford this house based on my current tax-loss harvesting strategy?'"],"value_proposition":"Transforming the bank from a passive storage bucket into an active, intelligent partner that manages your money with the precision of a high-end quantitative trading desk."},"hypothetical_investment_rejection_reasoning":{"trust_and_delegation_risk":"The 'Agency Gap': Selfin’s success requires users to delegate actual movement of funds to an AI. While technically feasible, the psychological barrier to letting an algorithm handle a life savings is massive. We are concerned the 'trust cycle' for this product will be too long for venture-scale growth in the near term.","the_aggregator_dependency":"The platform is entirely dependent on the stability of third-party APIs (like Plaid). If major banks decide to block these 'agentic' aggregators to protect their own ecosystems, Selfin’s core value proposition disappears. We prefer to invest in companies that own the underlying ledger.","incumbent_sherlocking":"Massive neobanks like Revolut and Chime have the same data and much larger engineering budgets. We believe they will 'Sherlock' Selfin’s features—integrating similar AI agents directly into their apps—before Selfin can acquire a defensive number of users.","regulatory_headwinds":"An 'AI-native bank' that makes autonomous financial decisions for consumers is a prime target for the CFPB. The potential for 'algorithmic bias' in lending or automated advice could lead to crippling legal and compliance costs that a seed-stage team is ill-equipped to handle.","low-retention_utility":"There is a risk that this is a 'set-it-and-forget-it' tool. Once the AI optimizes the user's accounts, there may be little reason for the user to return to the app daily, making it difficult to build a high-engagement platform or a successful secondary marketplace for financial products."},"critical_assumptions":[{"assumption_type":"pass_rationale","assumption_text":"Trust And Delegation Risk","must_be_true":"The 'Agency Gap': Selfin’s success requires users to delegate actual movement of funds to an AI. While technically feasible, the psychological barrier to letting an algorithm handle a life savings is massive. We are concerned the 'trust cycle' for this product will be too long for venture-scale growth in the near term.","failure_mode":"The 'Agency Gap': Selfin’s success requires users to delegate actual movement of funds to an AI. While technically feasible, the psychological barrier to letting an algorithm handle a life savings is massive. We are concerned the 'trust cycle' for this product will be too long for venture-scale growth in the near term.","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"The Aggregator Dependency","must_be_true":"The platform is entirely dependent on the stability of third-party APIs (like Plaid). If major banks decide to block these 'agentic' aggregators to protect their own ecosystems, Selfin’s core value proposition disappears. We prefer to invest in companies that own the underlying ledger.","failure_mode":"The platform is entirely dependent on the stability of third-party APIs (like Plaid). If major banks decide to block these 'agentic' aggregators to protect their own ecosystems, Selfin’s core value proposition disappears. We prefer to invest in companies that own the underlying ledger.","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"Incumbent Sherlocking","must_be_true":"Massive neobanks like Revolut and Chime have the same data and much larger engineering budgets. We believe they will 'Sherlock' Selfin’s features—integrating similar AI agents directly into their apps—before Selfin can acquire a defensive number of users.","failure_mode":"Massive neobanks like Revolut and Chime have the same data and much larger engineering budgets. We believe they will 'Sherlock' Selfin’s features—integrating similar AI agents directly into their apps—before Selfin can acquire a defensive number of users.","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"Regulatory Headwinds","must_be_true":"An 'AI-native bank' that makes autonomous financial decisions for consumers is a prime target for the CFPB. The potential for 'algorithmic bias' in lending or automated advice could lead to crippling legal and compliance costs that a seed-stage team is ill-equipped to handle.","failure_mode":"An 'AI-native bank' that makes autonomous financial decisions for consumers is a prime target for the CFPB. The potential for 'algorithmic bias' in lending or automated advice could lead to crippling legal and compliance costs that a seed-stage team is ill-equipped to handle.","is_linchpin":false},{"assumption_type":"pass_rationale","assumption_text":"Low-Retention Utility","must_be_true":"There is a risk that this is a 'set-it-and-forget-it' tool. Once the AI optimizes the user's accounts, there may be little reason for the user to return to the app daily, making it difficult to build a high-engagement platform or a successful secondary marketplace for financial products.","failure_mode":"There is a risk that this is a 'set-it-and-forget-it' tool. Once the AI optimizes the user's accounts, there may be little reason for the user to return to the app daily, making it difficult to build a high-engagement platform or a successful secondary marketplace for financial products.","is_linchpin":false}]}$j$::jsonb
);

INSERT INTO public.deal_problem (
  deal_id, analysis_id,
  problem_statement, root_cause_depth, economic_gravity, structural_urgency,
  persona_clarity, economic_buyer_persona, budget_priority_validation,
  stated_problem_ref, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  '1b000000-0000-4000-8000-00000000000a'::uuid,
  'Personal finance is ''fragmented and painful,'' with assets scattered across dozens of apps that don''t communicate, leading to missed wealth-building opportunities.

Barriers:
1. Decision Overload: Users struggle to manually decide between paying off debt, funding a 401k, or moving money to high-yield savings.
2. Siloed Data: Banks only see a fraction of a user''s financial life, resulting in generic, disconnected advice.
3. Administrative Burden: Managing wealth effectively currently requires spreadsheets and hours of manual research that most people avoid.',
  'Decision Overload: Users struggle to manually decide between paying off debt, funding a 401k, or moving money to high-yield savings.',
  'Economic impact implied by: Decision Overload: Users struggle to manually decide between paying off debt, funding a 401k, or moving money to high-yield savings. Siloed Data: Banks only see a fraction of a user''s financial life, resulting in generic, disconnected advice.',
  '1. Decision Overload: Users struggle to manually decide between paying off debt, funding a 401k, or moving money to high-yield savings.
2. Siloed Data: Banks only see a fraction of a user''s financial life, resulting in generic, disconnected advice.
3. Administrative Burden: Managing wealth effectively currently requires spreadsheets and hours of manual research that most people avoid.',
  'Enterprise / regulated financial buyer',
  'Enterprise / regulated financial buyer',
  'Decision Overload: Users struggle to manually decide between paying off debt, funding a 401k, or moving money to high-yield savings.',
  'Personal finance is ''fragmented and painful,'' with assets scattered across dozens of apps that don''t communicate, leading to missed wealth-building opportunities.',
  'historical_seed'
);

INSERT INTO public.deal_solution (
  deal_id, analysis_id,
  solution_summary, product_type, moat_type, replication_difficulty, compounding_potential,
  technical_moat_evidence, differentiation_proof_points, competitor_landscape_json, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  '1b000000-0000-4000-8000-00000000000a'::uuid,
  'AI-Native Neobank & Financial Assistant

Transforming the bank from a passive storage bucket into an active, intelligent partner that manages your money with the precision of a high-end quantitative trading desk.',
  'AI-Native Neobank & Financial Assistant',
  'technical / data',
  'High replication cost: Full-Context Banking: Connects all financial products—credit, investments, crypto, 401ks, and savings—into one intelligent interface.; Autonomous Financial Agents: AI agents that ''act'' for you, such as automatically moving idle cash into the highest-yielding verified account.',
  'Compounding via: Transforming the bank from a passive storage bucket into an active, intelligent partner that manages your money with the precision of a high-end quantitative trading desk.',
  'Full-Context Banking: Connects all financial products—credit, investments, crypto, 401ks, and savings—into one intelligent interface.
Autonomous Financial Agents: AI agents that ''act'' for you, such as automatically moving idle cash into the highest-yielding verified account.
Personalized Optimizations: Real-time alerts and automated actions to reduce fees and capture better interest rates based on your entire net worth.
Generative Intelligence: A conversational ''financial brain'' that answers complex questions like ''Can I afford this house based on my current tax-loss harvesting strategy?''',
  $j$["Full-Context Banking: Connects all financial products—credit, investments, crypto, 401ks, and savings—into one intelligent interface.","Autonomous Financial Agents: AI agents that 'act' for you, such as automatically moving idle cash into the highest-yielding verified account.","Personalized Optimizations: Real-time alerts and automated actions to reduce fees and capture better interest rates based on your entire net worth.","Generative Intelligence: A conversational 'financial brain' that answers complex questions like 'Can I afford this house based on my current tax-loss harvesting strategy?'"]$j$::jsonb,
  $j$[{"name":"Revolut","category":"incumbent / alternative","note":"Referenced in source narrative"},{"name":"Chime","category":"incumbent / alternative","note":"Referenced in source narrative"}]$j$::jsonb,
  'historical_seed'
);

INSERT INTO public.deal_traction (
  deal_id, analysis_id,
  traction_evidence_json, phase1_traction_json, milestones_detected,
  inferred_stage, benchmark_context, revenue_data, growth_signals, customer_depth, user_traction,
  notable_partners_and_validation, investor_list, signal_completeness
) VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  '1b000000-0000-4000-8000-00000000000a'::uuid,
  $j${"funding":{"total_funding":"$7.0 Million","latest_round":"Seed Round (Post-YC F25)","lead_investors":["Y Combinator","Ripple Impact Investments","Transpose Platform Management"]},"milestones":["Member of the Y Combinator Fall 2025 batch.","Grew a massive waitlist for their 'First AI Bank' concept during the YC period.","Integrated with major financial data aggregators to support a unified view of 401ks, crypto, and traditional banking.","Successfully launched an AI-powered assistant that automates cross-account financial optimizations for early beta users."]}$j$::jsonb,
  $j${"funding":{"total_funding":"$7.0 Million","latest_round":"Seed Round (Post-YC F25)","lead_investors":["Y Combinator","Ripple Impact Investments","Transpose Platform Management"]},"milestones":["Member of the Y Combinator Fall 2025 batch.","Grew a massive waitlist for their 'First AI Bank' concept during the YC period.","Integrated with major financial data aggregators to support a unified view of 401ks, crypto, and traditional banking.","Successfully launched an AI-powered assistant that automates cross-account financial optimizations for early beta users."]}$j$::jsonb,
  $j$["Member of the Y Combinator Fall 2025 batch.","Grew a massive waitlist for their 'First AI Bank' concept during the YC period.","Integrated with major financial data aggregators to support a unified view of 401ks, crypto, and traditional banking.","Successfully launched an AI-powered assistant that automates cross-account financial optimizations for early beta users."]$j$::jsonb,
  'Founded 2025',
  'HQ: San Francisco, CA & London, UK | Founded: 2025 | Round: Seed Round (Post-YC F25)',
  NULL,
  NULL,
  'Grew a massive waitlist for their ''First AI Bank'' concept during the YC period.
Integrated with major financial data aggregators to support a unified view of 401ks, crypto, and traditional banking.
Successfully launched an AI-powered assistant that automates cross-account financial optimizations for early beta users.',
  'Successfully launched an AI-powered assistant that automates cross-account financial optimizations for early beta users.',
  $j$["Member of the Y Combinator Fall 2025 batch.","Grew a massive waitlist for their 'First AI Bank' concept during the YC period.","Integrated with major financial data aggregators to support a unified view of 401ks, crypto, and traditional banking.","Successfully launched an AI-powered assistant that automates cross-account financial optimizations for early beta users."]$j$::jsonb,
  $j$[{"name":"Y Combinator","role":"lead"},{"name":"Ripple Impact Investments","role":"lead"},{"name":"Transpose Platform Management","role":"lead"}]$j$::jsonb,
  'historical_seed'
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  'founded_year',
  '2025',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  'headquarters',
  'San Francisco, CA & London, UK',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  'total_funding',
  '$7.0 Million',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  'latest_round',
  'Seed Round (Post-YC F25)',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  'traction_highlight_1',
  'Member of the Y Combinator Fall 2025 batch.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  'traction_highlight_2',
  'Grew a massive waitlist for their ''First AI Bank'' concept during the YC period.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  'traction_highlight_3',
  'Integrated with major financial data aggregators to support a unified view of 401ks, crypto, and traditional banking.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_metrics (deal_id, metric_name, metric_value, confidence, source_type, is_verified)
VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  'traction_highlight_4',
  'Successfully launched an AI-powered assistant that automates cross-account financial optimizations for early beta users.',
  'deck_text',
  'historical_seed',
  false
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  '1b000000-0000-4000-8000-00000000000a'::uuid,
  'Revolut',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_competitors (deal_id, analysis_id, competitor_name, category, threat_level, threat_assessment)
VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  '1b000000-0000-4000-8000-00000000000a'::uuid,
  'Chime',
  'incumbent / alternative',
  'referenced',
  'Referenced in source narrative'
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  '6d8c434a-d078-46a9-af0f-a7107f271f90'::uuid,
  'lead',
  'Seed Round (Post-YC F25)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  '6cf97f50-aaf3-43d7-a7b5-04764ac63e16'::uuid,
  'lead',
  'Seed Round (Post-YC F25)',
  NULL
);

INSERT INTO public.deal_investors (deal_id, investor_id, role, round_name, amount)
VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  'c8ec731e-b43e-4c29-a7dc-6f114fd30736'::uuid,
  'lead',
  'Seed Round (Post-YC F25)',
  NULL
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  '1b000000-0000-4000-8000-00000000000a'::uuid,
  'Trust And Delegation Risk',
  'pass_rationale',
  NULL,
  'The ''Agency Gap'': Selfin’s success requires users to delegate actual movement of funds to an AI. While technically feasible, the psychological barrier to letting an algorithm handle a life savings is massive. We are concerned the ''trust cycle'' for this product will be too long for venture-scale growth in the near term.',
  false,
  NULL,
  NULL,
  'The ''Agency Gap'': Selfin’s success requires users to delegate actual movement of funds to an AI. While technically feasible, the psychological barrier to letting an algorithm handle a life savings is massive. We are concerned the ''trust cycle'' for this product will be too long for venture-scale growth in the near term.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  '1b000000-0000-4000-8000-00000000000a'::uuid,
  'The Aggregator Dependency',
  'pass_rationale',
  NULL,
  'The platform is entirely dependent on the stability of third-party APIs (like Plaid). If major banks decide to block these ''agentic'' aggregators to protect their own ecosystems, Selfin’s core value proposition disappears. We prefer to invest in companies that own the underlying ledger.',
  false,
  NULL,
  NULL,
  'The platform is entirely dependent on the stability of third-party APIs (like Plaid). If major banks decide to block these ''agentic'' aggregators to protect their own ecosystems, Selfin’s core value proposition disappears. We prefer to invest in companies that own the underlying ledger.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  '1b000000-0000-4000-8000-00000000000a'::uuid,
  'Incumbent Sherlocking',
  'pass_rationale',
  NULL,
  'Massive neobanks like Revolut and Chime have the same data and much larger engineering budgets. We believe they will ''Sherlock'' Selfin’s features—integrating similar AI agents directly into their apps—before Selfin can acquire a defensive number of users.',
  false,
  NULL,
  NULL,
  'Massive neobanks like Revolut and Chime have the same data and much larger engineering budgets. We believe they will ''Sherlock'' Selfin’s features—integrating similar AI agents directly into their apps—before Selfin can acquire a defensive number of users.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  '1b000000-0000-4000-8000-00000000000a'::uuid,
  'Regulatory Headwinds',
  'pass_rationale',
  NULL,
  'An ''AI-native bank'' that makes autonomous financial decisions for consumers is a prime target for the CFPB. The potential for ''algorithmic bias'' in lending or automated advice could lead to crippling legal and compliance costs that a seed-stage team is ill-equipped to handle.',
  false,
  NULL,
  NULL,
  'An ''AI-native bank'' that makes autonomous financial decisions for consumers is a prime target for the CFPB. The potential for ''algorithmic bias'' in lending or automated advice could lead to crippling legal and compliance costs that a seed-stage team is ill-equipped to handle.'
);

INSERT INTO public.deal_assumptions (
  deal_id, analysis_id,
  assumption_text, assumption_type, inversion, must_be_true,
  is_linchpin, fragility_score, why_fragile, failure_mode
) VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  '1b000000-0000-4000-8000-00000000000a'::uuid,
  'Low-Retention Utility',
  'pass_rationale',
  NULL,
  'There is a risk that this is a ''set-it-and-forget-it'' tool. Once the AI optimizes the user''s accounts, there may be little reason for the user to return to the app daily, making it difficult to build a high-engagement platform or a successful secondary marketplace for financial products.',
  false,
  NULL,
  NULL,
  'There is a risk that this is a ''set-it-and-forget-it'' tool. Once the AI optimizes the user''s accounts, there may be little reason for the user to return to the app daily, making it difficult to build a high-engagement platform or a successful secondary marketplace for financial products.'
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  'Paula Gutierrez',
  'Co-founder & CEO',
  'Aerospace Engineering (Imperial/MIT/Berkeley); former Quantitative Analyst at Bank of America and researcher at NASA and Rolls-Royce.',
  ARRAY['Imperial', 'MIT', 'Berkeley']::text[],
  'YC Fall 2025',
  $j$["NASA and Rolls-Royce"]$j$::jsonb,
  $j$["Imperial","MIT","Berkeley","Bank of America and researcher at NASA and Rolls-Royce"]$j$::jsonb,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Paula Gutierrez","role":"Co-founder & CEO","background":"Aerospace Engineering (Imperial/MIT/Berkeley); former Quantitative Analyst at Bank of America and researcher at NASA and Rolls-Royce."}$j$::jsonb
);

INSERT INTO public.founders (
  deal_id, name, role, background_summary,
  universities, yc_batch, previous_companies, institutions, awards_and_honors, past_exits,
  enrichment_source, enrichment_raw
) VALUES (
  '1a000000-0000-4000-8000-00000000000a'::uuid,
  'Joel Tomas Pimentel',
  'Co-founder & CTO',
  'Aerospace Engineering (Imperial/Stanford); former consultant at BCG; specialized in complex engineering and ''rocket science'' systems.',
  ARRAY['Imperial', 'Stanford']::text[],
  'YC Fall 2025',
  $j$["BCG"]$j$::jsonb,
  $j$["Imperial","Stanford","BCG"]$j$::jsonb,
  NULL,
  NULL,
  'invested-companies-md',
  $j${"name":"Joel Tomas Pimentel","role":"Co-founder & CTO","background":"Aerospace Engineering (Imperial/Stanford); former consultant at BCG; specialized in complex engineering and 'rocket science' systems."}$j$::jsonb
);

COMMIT;
