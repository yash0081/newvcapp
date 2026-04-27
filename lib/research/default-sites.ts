import type { WebsiteCategory } from "@/lib/research/types";

export type DefaultResearchSite = {
  domain: string;
  label: string;
  categories: WebsiteCategory[];
  useCases: string[];
};

export const DEFAULT_RESEARCH_SITES: DefaultResearchSite[] = [
  {
    domain: "company-website",
    label: "Company website",
    categories: ["product", "traction", "general"],
    useCases: ["product messaging", "pricing", "customer evidence"],
  },
  {
    domain: "linkedin.com",
    label: "LinkedIn",
    categories: ["founder", "hiring", "traction"],
    useCases: ["founder background", "team signals", "hiring velocity"],
  },
  {
    domain: "crunchbase.com",
    label: "Crunchbase",
    categories: ["traction", "market"],
    useCases: ["fundraising history", "investors", "company profile"],
  },
  {
    domain: "news.google.com",
    label: "Google News",
    categories: ["news", "market", "general"],
    useCases: ["recent announcements", "press coverage", "market changes"],
  },
  {
    domain: "github.com",
    label: "GitHub",
    categories: ["product", "founder"],
    useCases: ["technical depth", "open-source signals", "release activity"],
  },
  {
    domain: "wellfound.com",
    label: "Wellfound",
    categories: ["hiring", "traction"],
    useCases: ["open roles", "compensation bands", "team growth clues"],
  },
  {
    domain: "sec.gov",
    label: "SEC EDGAR",
    categories: ["legal", "market"],
    useCases: ["regulatory filings", "public-company comparisons"],
  },
  {
    domain: "g2.com",
    label: "G2",
    categories: ["product", "market"],
    useCases: ["customer sentiment", "competitive positioning", "buyer language"],
  },
];

