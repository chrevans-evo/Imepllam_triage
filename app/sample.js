// A fictional organisation used to show the app before a client's own list is loaded.
// Titles deliberately include the noise real HR data has (seniority, regions, abbreviations).
export const SAMPLE_NAME = "Sample: mid-size Australian insurer (fictional)";

export const SAMPLE_CSV = `Department,Job title,Headcount
Customer Operations,Contact Centre Consultant,220
Customer Operations,Claims Officer,140
Customer Operations,Senior Claims Assessor,45
Customer Operations,Customer Service Team Leader,28
Customer Operations,Loss Adjuster,20
Underwriting,Underwriter,60
Underwriting,Underwriting Assistant,35
Underwriting,Actuary,12
Underwriting,Actuarial Analyst,14
Finance,Accounts Payable Officer,18
Finance,Payroll Officer,6
Finance,Financial Analyst,15
Finance,Management Accountant,10
Finance,Credit Controller,8
People & Culture,HR Business Partner,9
People & Culture,Recruitment Consultant,7
People & Culture,Learning & Development Specialist,5
People & Culture,HR Administrator,8
Technology,Software Developer,45
Technology,IT Service Desk Analyst,30
Technology,Data Scientist,10
Technology,Business Analyst,25
Technology,Cyber Security Analyst,8
Technology,Project Manager,15
Sales & Marketing,Insurance Broker,40
Sales & Marketing,Sales Representative - APAC,55
Sales & Marketing,Marketing Coordinator,10
Sales & Marketing,Copywriter,4
Legal & Risk,Compliance Officer,12
Legal & Risk,Legal Counsel,6
Legal & Risk,Fraud Investigator,14
Legal & Risk,Risk Analyst,10
Corporate Services,Receptionist,6
Corporate Services,Facilities Manager,3
Corporate Services,Executive Assistant,7`;

// Matches for the sample checked by hand, so the example opens clean.
// A client's own list always goes through the review step instead.
export const SAMPLE_MATCHES = {
  "Contact Centre Consultant": "call-centre-agent",
  "Claims Officer": "insurance-claims-handler",
  "Senior Claims Assessor": "insurance-claims-handler",
  "Customer Service Team Leader": "contact-centre-supervisor",
  "Underwriter": "insurance-underwriter",
  "Underwriting Assistant": "insurance-clerk",
  "Management Accountant": "accountant",
  "HR Business Partner": "human-resources-officer",
  "HR Administrator": "human-resources-assistant",
  "IT Service Desk Analyst": "ict-help-desk-agent",
  "Cyber Security Analyst": "ict-security-administrator",
  "Sales Representative - APAC": "commercial-sales-representative",
  "Marketing Coordinator": "marketing-assistant",
  "Compliance Officer": "regulatory-affairs-manager",
  "Legal Counsel": "corporate-lawyer",
  "Risk Analyst": "insurance-risk-consultant",
};
