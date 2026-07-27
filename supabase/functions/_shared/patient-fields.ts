// Shared enums used by parse-update and parse-bulk-update so the two stay
// in sync with the frontend's Status/Purpose dropdowns without duplicating
// the list in each function.
export const STATUS_VALUES = [
  "", "Screening", "Under Investigation", "Treatment", "Admitted",
  "On Medication", "Follow-up", "Completed",
] as const;

export const PURPOSE_VALUES = [
  "", "Travel", "Screening", "Treatment", "Medicine", "Hospital Stay", "Other",
] as const;
