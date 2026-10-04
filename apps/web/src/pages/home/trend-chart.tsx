import type { TrendMonth } from '@camex/shared';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  abbreviateAmount,
  formatAmount,
  formatCount,
  formatMonth,
  formatShortMonth,
} from '@/lib/format';

interface Point {
  month: string;
  /** Bar heights only: amounts people read go through the exact decimal strings. */
  invoicedValue: number;
  paidValue: number;
  source: TrendMonth;
}

function MonthTick({
  x,
  y,
  payload,
  currentMonth,
}: {
  x?: number;
  y?: number;
  payload?: { value: string };
  currentMonth: string;
}) {
  const month = payload?.value ?? '';
  const current = month === currentMonth;
  return (
    <g transform={`translate(${String(x ?? 0)},${String(y ?? 0)})`}>
      <text
        dy={14}
        textAnchor="middle"
        className={current ? 'fill-foreground' : 'fill-muted'}
        fontSize={12}
      >
        {formatShortMonth(month)}
      </text>
      {current && (
        <text dy={28} textAnchor="middle" className="fill-muted" fontSize={11}>
          This month
        </text>
      )}
    </g>
  );
}

function ChartTooltip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: { payload?: Point }[];
  currency: string;
}) {
  const point = payload?.[0]?.payload;
  if (!active || point === undefined) return null;
  const { source } = point;
  return (
    <div className="rounded-control border border-line bg-overlay px-3 py-2 text-xs shadow-overlay">
      <p className="mb-1 font-medium">{formatMonth(source.month)}</p>
      <p className="flex items-center gap-2">
        <span className="size-2 rounded-[2px] bg-primary" aria-hidden />
        Invoiced{' '}
        <span className="tabular ml-auto pl-4">{formatAmount(source.invoiced, currency)}</span>
      </p>
      <p className="flex items-center gap-2">
        <span className="size-2 rounded-[2px] bg-muted" aria-hidden />
        Paid <span className="tabular ml-auto pl-4">{formatAmount(source.paid, currency)}</span>
      </p>
    </div>
  );
}

/**
 * Invoiced and paid per month, one currency: grouped bars, no gridlines but a faint baseline,
 * abbreviated axis amounts, exact amounts in the tooltip. Screen readers get the same numbers as
 * a table. Colours come from the theme through `currentColor`, so they follow light and dark.
 */
export function TrendChart({
  trend,
  currency,
  currentMonth,
}: {
  trend: TrendMonth[];
  currency: string;
  currentMonth: string;
}) {
  const points: Point[] = trend.map((month) => ({
    month: month.month,
    invoicedValue: Number(month.invoiced),
    paidValue: Number(month.paid),
    source: month,
  }));

  return (
    <>
      <div className="h-56 w-full" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={points}
            barGap={2}
            barCategoryGap="22%"
            // Room on the right for the centred "This month" under the last bar.
            margin={{ top: 8, right: 24, bottom: 4, left: 0 }}
            accessibilityLayer={false}
          >
            <XAxis
              dataKey="month"
              interval={0}
              height={36}
              tickLine={false}
              axisLine={{ stroke: 'currentColor' }}
              className="text-line"
              tick={<MonthTick currentMonth={currentMonth} />}
            />
            <YAxis
              width={44}
              axisLine={false}
              tickLine={false}
              tickCount={4}
              tickFormatter={(value: number) => abbreviateAmount(value)}
              tick={{ fill: 'currentColor', fontSize: 12 }}
              className="text-muted"
            />
            <Tooltip
              cursor={{ fill: 'currentColor', className: 'text-foreground/5' }}
              content={<ChartTooltip currency={currency} />}
              isAnimationActive={false}
            />
            <Bar
              dataKey="invoicedValue"
              name="Invoiced"
              fill="currentColor"
              className="text-primary"
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
            <Bar
              dataKey="paidValue"
              name="Paid"
              fill="currentColor"
              className="text-muted"
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="sr-only">
        <table>
          <caption>Invoiced and paid per month, {currency}</caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col">Invoiced</th>
              <th scope="col">Paid</th>
            </tr>
          </thead>
          <tbody>
            {trend.map((month) => (
              <tr key={month.month}>
                <th scope="row">{formatMonth(month.month)}</th>
                <td>
                  {formatAmount(month.invoiced, currency)} ({formatCount(month.invoicedCount)}{' '}
                  invoices)
                </td>
                <td>
                  {formatAmount(month.paid, currency)} ({formatCount(month.paidCount)} invoices)
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
