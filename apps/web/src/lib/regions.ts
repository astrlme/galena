// Where an AWS region is, for people who don't know the codes by heart. Codes not listed read as
// themselves.

const NAMES: Record<string, string> = {
  "eu-west-1": "Ireland",
  "eu-west-2": "London",
  "eu-west-3": "Paris",
  "eu-central-1": "Frankfurt",
  "eu-central-2": "Zurich",
  "eu-north-1": "Stockholm",
  "eu-south-1": "Milan",
  "eu-south-2": "Spain",
  "us-east-1": "N. Virginia",
  "us-east-2": "Ohio",
  "us-west-1": "N. California",
  "us-west-2": "Oregon",
  "ca-central-1": "Canada",
  "sa-east-1": "São Paulo",
  "ap-south-1": "Mumbai",
  "ap-northeast-1": "Tokyo",
  "ap-northeast-2": "Seoul",
  "ap-southeast-1": "Singapore",
  "ap-southeast-2": "Sydney",
};

export const regionName = (region: string) => NAMES[region] ?? region;
