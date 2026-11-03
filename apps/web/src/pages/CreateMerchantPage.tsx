import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  SUPPORTED_CURRENCIES,
  createMerchant,
  type NewMerchant,
} from '../api/merchants';
import { countryName } from '../components/countries';
import { ErrorAlert } from '../components/ErrorAlert';

/** The fields the user types; the country and the currency are fixed. */
type TextField = Exclude<
  keyof NewMerchant,
  'country_code' | 'default_currency'
>;

type TextValues = Pick<NewMerchant, TextField>;

const TEXT_FIELDS: readonly {
  readonly name: TextField;
  readonly label: string;
  readonly maxLength: number;
  readonly help?: string;
}[] = [
  { name: 'legal_name', label: 'Legal name', maxLength: 200 },
  { name: 'display_name', label: 'Display name', maxLength: 100 },
  {
    name: 'business_type',
    label: 'Business type',
    maxLength: 50,
    help: 'Legal form, for example LLC.',
  },
  { name: 'industry', label: 'Industry', maxLength: 100 },
];

/** The only country the form offers for now. */
const DEMO_COUNTRY_CODE = 'US';

/** The only currency the API supports. */
const DEMO_CURRENCY = SUPPORTED_CURRENCIES[0];

const EMPTY: TextValues = {
  legal_name: '',
  display_name: '',
  business_type: '',
  industry: '',
};

/**
 * The form that registers a merchant with every field the API requires. The
 * country and the default currency are shown but cannot be chosen: the form
 * always sends the United States (`US`) and USD, the only currency the API
 * supports. The merchant starts in DRAFT; the form opens its page once it
 * exists.
 */
export function CreateMerchantPage() {
  const navigate = useNavigate();
  const [values, setValues] = useState<TextValues>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  function set(field: TextField, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function submit() {
    setSubmitting(true);
    setError(undefined);
    try {
      const merchant = await createMerchant({
        ...values,
        country_code: DEMO_COUNTRY_CODE,
        default_currency: DEMO_CURRENCY,
      });
      void navigate(`/merchants/${merchant.id}`);
    } catch (caught) {
      setError(caught);
      setSubmitting(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <h1 className="h3 mb-3">Create merchant</h1>
      <ErrorAlert error={error} />
      <form onSubmit={handleSubmit}>
        {TEXT_FIELDS.map((field) => (
          <div className="mb-3" key={field.name}>
            <label htmlFor={field.name} className="form-label">
              {field.label}
            </label>
            <input
              id={field.name}
              className="form-control"
              required
              maxLength={field.maxLength}
              value={values[field.name]}
              onChange={(event) => set(field.name, event.target.value)}
            />
            {field.help === undefined ? null : (
              <div className="form-text">{field.help}</div>
            )}
          </div>
        ))}
        <div className="mb-3">
          <label htmlFor="country_code" className="form-label">
            Country
          </label>
          <select
            id="country_code"
            className="form-select"
            disabled
            value={DEMO_COUNTRY_CODE}
            aria-describedby="country_code_help"
          >
            <option value={DEMO_COUNTRY_CODE}>
              {countryName(DEMO_COUNTRY_CODE)}
            </option>
          </select>
          <div id="country_code_help" className="form-text">
            Only the United States is available for now.
          </div>
        </div>
        <div className="mb-3">
          <label htmlFor="default_currency" className="form-label">
            Default currency
          </label>
          <select
            id="default_currency"
            className="form-select"
            disabled
            value={DEMO_CURRENCY}
            aria-describedby="default_currency_help"
          >
            <option value={DEMO_CURRENCY}>{DEMO_CURRENCY}</option>
          </select>
          <div id="default_currency_help" className="form-text">
            Only USD is supported for now. It cannot be changed after the
            merchant is created.
          </div>
        </div>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create merchant'}
        </button>
        <Link to="/merchants" className="btn btn-link">
          Cancel
        </Link>
      </form>
    </div>
  );
}
