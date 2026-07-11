/* eslint-disable */
// GENERATED from scripts/dd-json.schema.json — do not edit by hand.
// Regenerate with: npm run gen:types

/**
 * The canonical JSON representation of a data dictionary produced by dd_api's DataDictionary.to_json() and accepted by from_json(). A versioned wrapper around a list of data elements that mirror the typed model.
 */
export interface DataDictionaryJSONDdJson {
  /**
   * Format discriminator; always the literal "dd-json".
   */
  format: "dd-json";
  /**
   * Schema version of this representation. Consumers should reject versions they do not understand.
   */
  version: 1;
  /**
   * The data elements, in order (element order mirrors the order of fields in the datafile).
   */
  elements: DataElement[];
}
/**
 * One field of the datafile. In the full form, blank single-valued fields are null and list-valued fields are arrays (possibly empty). In the compact form (to_json(compact=True)) those null/empty fields may be omitted; only the keys below are always present.
 */
export interface DataElement {
  /**
   * The field's unique identifier (variable name).
   */
  id: string;
  /**
   * The field's human-readable name.
   */
  label: string;
  /**
   * A datatype name from the specification (e.g. integer, string, date_mdy).
   */
  datatype: string;
  /**
   * Alternative identifiers for the field.
   */
  aliases?: string[];
  /**
   * What the field means (may contain Markdown); null when absent.
   */
  description?: string | null;
  /**
   * The section (group of related fields) this element belongs to; null when the dictionary has no sections.
   */
  section?: string | null;
  /**
   * Whether one datafile cell holds one value (single) or several (multiple).
   */
  cardinality: "single" | "multiple";
  /**
   * Ontology term identifiers (full IRIs or compact OBO ids).
   */
  terms?: string[];
  /**
   * An XSD-flavour regular expression values must match; null when none.
   */
  pattern?: string | null;
  /**
   * The unit of measure as written; null when none.
   */
  unit?: string | null;
  /**
   * The permissible values, when the field is restricted to a fixed choice list; empty otherwise.
   */
  enumeration?: EnumItem[];
  /**
   * Codes that stand for 'no data' (refused, not collected, ...).
   */
  missing_value_codes?: EnumItem[];
  /**
   * The condition under which the field holds a value (the Precondition grammar); null when the field always applies.
   */
  precondition?: string | null;
  /**
   * Whether the field must hold a value (subject to its precondition).
   */
  required: boolean;
  /**
   * Example values for the field.
   */
  examples?: string[];
  /**
   * Free-text notes; null when absent.
   */
  notes?: string | null;
  /**
   * Where the field came from (study, instrument, URL); null when absent.
   */
  provenance?: string | null;
  /**
   * A URL with more information; null when absent.
   */
  see_also?: string | null;
}
/**
 * One permissible value: the value as it appears in the datafile, a human-readable label, and an optional ontology term IRI. In the compact form a null iri may be omitted.
 */
export interface EnumItem {
  value: string;
  label: string;
  iri?: string | null;
}
