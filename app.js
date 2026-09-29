-- =====================================================================
--  La Habana Staff — update 4: payroll changes (29 Sep)
--  Run once in Supabase → SQL Editor, AFTER update-3-payroll.sql.
--  Safe to run again.
--
--  • Service charge is shared by days worked. The owner is left out.
--  • Overtime is paid only to people ticked "Gets overtime".
--  • Everyone on the staff list gets a payslip, even if their pay isn't
--    entered yet (the app warns first). The owner gets one only if the
--    owner's own pay has been entered.
--  • Owner clock-ins are not counted.
-- =====================================================================
 
do $$
begin
  if to_regclass('public.payslips') is null then
    raise exception 'Run update-3-payroll.sql first, then run this file again.';
  end if;
end $$;
 
alter table public.payslips add column if not exists days_worked int not null default 0;
 
-- Overtime is now opt-in. Everyone starts unticked once; after that, the
-- owner's ticks are kept even if this file is run again.
alter table public.pay_profiles alter column ot_eligible set default false;
alter table public.pay_settings add column if not exists ot_optin_done boolean not null default false;
update public.pay_profiles set ot_eligible = false
  where exists (select 1 from public.pay_settings where id = 1 and not ot_optin_done);
update public.pay_settings set ot_optin_done = true where id = 1;
 
-- Service charge by days worked is the only rule now.
alter table public.pay_settings drop constraint if exists pay_settings_sc_method_check;
update public.pay_settings set sc_method = 'days' where id = 1;
alter table public.pay_settings alter column sc_method set default 'days';
 
create or replace function public.payroll_calculate(p_run uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r pay_runs; st pay_settings; pp record;
  v_days int; v_hours numeric; v_ot numeric; v_hol numeric; v_rate numeric; v_worked int;
  v_from date; v_to date; v_emp int; v_factor numeric;
  v_basic numeric; v_otpay numeric; v_holpay numeric; v_allow jsonb;
  v_paid uuid[] := '{}';
  v_weight numeric; v_given numeric; v_top uuid;
  v_open int; v_auto int; v_missing int;
begin
  if not public.lh_is_owner() then raise exception 'Only the owner can run payroll.'; end if;
  select * into r from pay_runs where id = p_run for update;
  if not found then raise exception 'That pay run no longer exists.'; end if;
  if r.status <> 'draft' then raise exception 'This month is published. Reopen it as a draft first.'; end if;
  select * into st from pay_settings where id = 1;
  v_days := r.period_end - r.period_start + 1;
 
  -- everyone on the staff list has a pay record, even a blank one
  insert into pay_profiles (user_id)
  select id from profiles pr
  where pr.active and pr.role <> 'owner'
    and not exists (select 1 from pay_profiles x where x.user_id = pr.id);
 
  if to_regclass('pg_temp._lh_hours') is not null then drop table pg_temp._lh_hours; end if;
  create temp table _lh_hours on commit drop as
    select s.user_id, (s.started_at at time zone 'Indian/Maldives')::date as d,
           sum(extract(epoch from (s.ended_at - s.started_at)) / 3600.0) as h
    from shifts s
    join profiles pr on pr.id = s.user_id and pr.role <> 'owner'
    where s.ended_at is not null and s.ended_at > s.started_at
      and (s.started_at at time zone 'Indian/Maldives')::date between r.period_start - 6 and r.period_end
    group by 1, 2;
 
  for pp in
    select p.*, pr.full_name as pr_name, pr.display_name, pr.position, pr.role, pr.active as person_active,
           h.employee_no, h.contract_start, h.contract_end,
           ((p.pay_type = 'monthly' and p.basic_salary > 0) or (p.pay_type = 'hourly' and p.hourly_rate > 0)) as pay_set
    from pay_profiles p
    join profiles pr on pr.id = p.user_id
    left join staff_hr h on h.user_id = p.user_id
    where p.active
  loop
    -- the owner only gets a payslip if the owner's own pay is entered
    if pp.role = 'owner' and not pp.pay_set then continue; end if;
 
    select coalesce(sum(h), 0), count(*) into v_hours, v_worked from _lh_hours
      where user_id = pp.user_id and d between r.period_start and r.period_end;
 
    v_ot := 0;
    if pp.ot_eligible then
      select coalesce(sum(greatest(0, wk.total - st.week_hours)), 0) into v_ot
      from (
        select x.ws, (select coalesce(sum(h), 0) from _lh_hours
                      where user_id = pp.user_id and d between x.ws and x.ws + 6) as total
        from generate_series(r.period_start - (extract(isodow from r.period_start)::int - 1),
                             r.period_end, interval '7 days') g(ws0),
             lateral (select g.ws0::date as ws) x
        where x.ws + 6 between r.period_start and r.period_end
      ) wk;
    end if;
 
    select coalesce(sum(h), 0) into v_hol from _lh_hours
      where user_id = pp.user_id and d between r.period_start and r.period_end
        and (d = any (st.holidays) or (st.fridays_are_holidays and extract(isodow from d) = 5));
 
    v_from := greatest(r.period_start, coalesce(pp.contract_start, r.period_start));
    v_to   := least(r.period_end, coalesce(pp.contract_end, r.period_end));
    v_emp  := greatest(0, v_to - v_from + 1);
    if v_emp = 0 and v_hours = 0 then continue; end if;
    if not pp.person_active and v_hours = 0 then continue; end if;
    v_factor := v_emp::numeric / v_days;
 
    if pp.pay_type = 'monthly' then
      v_rate  := pp.basic_salary / st.month_hours;
      v_basic := round(pp.basic_salary * v_factor, 2);
      v_otpay := round(v_ot * v_rate * st.ot_rate, 2);
    else
      v_rate  := pp.hourly_rate;
      v_basic := round(v_hours * v_rate, 2);
      v_otpay := round(v_ot * v_rate * (st.ot_rate - 1), 2);
    end if;
    v_holpay := round(v_hol * v_rate * (st.holiday_rate - 1), 2);
 
    select coalesce(jsonb_agg(jsonb_build_object('name', a ->> 'name',
             'amount', round((a ->> 'amount')::numeric * v_factor, 2))), '[]'::jsonb)
      into v_allow
      from jsonb_array_elements(pp.allowances) a
      where coalesce((a ->> 'amount')::numeric, 0) > 0;
 
    insert into payslips as ps (run_id, user_id, full_name, designation, employee_no, pay_type, hourly_rate,
        days_in_period, days_employed, days_worked, hours, ot_hours, holiday_hours, basic, ot_pay, holiday_pay,
        allowances, sc_share, pay_method, bank_name, account_name, account_no)
    values (r.id, pp.user_id, coalesce(nullif(pp.pr_name, ''), pp.display_name), pp.position, pp.employee_no,
        pp.pay_type, round(v_rate, 4), v_days, v_emp, v_worked, round(v_hours, 2), round(v_ot, 2), round(v_hol, 2),
        v_basic, v_otpay, v_holpay, v_allow, 0, pp.pay_method, pp.bank_name, pp.account_name, pp.account_no)
    on conflict (run_id, user_id) do update set
        full_name = excluded.full_name, designation = excluded.designation, employee_no = excluded.employee_no,
        pay_type = excluded.pay_type, hourly_rate = excluded.hourly_rate,
        days_in_period = excluded.days_in_period, days_employed = excluded.days_employed,
        days_worked = excluded.days_worked,
        hours = excluded.hours, ot_hours = excluded.ot_hours, holiday_hours = excluded.holiday_hours,
        basic = excluded.basic, ot_pay = excluded.ot_pay, holiday_pay = excluded.holiday_pay,
        allowances = excluded.allowances, sc_share = 0,
        pay_method = excluded.pay_method, bank_name = excluded.bank_name,
        account_name = excluded.account_name, account_no = excluded.account_no;
    v_paid := v_paid || pp.user_id;
  end loop;
 
  delete from payslips where run_id = r.id and not (user_id = any (v_paid));
 
  -- service charge: pool × (my days worked ÷ everyone's days worked), owner left out
  if r.sc_pool > 0 then
    select coalesce(sum(ps.days_worked), 0) into v_weight
      from payslips ps join pay_profiles p on p.user_id = ps.user_id
      join profiles pr on pr.id = ps.user_id
      where ps.run_id = r.id and p.sc_eligible and pr.role <> 'owner';
    if v_weight > 0 then
      update payslips ps set sc_share = round(r.sc_pool * ps.days_worked / v_weight, 2)
        from pay_profiles p, profiles pr
        where p.user_id = ps.user_id and pr.id = ps.user_id and ps.run_id = r.id
          and p.sc_eligible and pr.role <> 'owner';
      select coalesce(sum(sc_share), 0) into v_given from payslips where run_id = r.id;
      if v_given <> r.sc_pool then
        select user_id into v_top from payslips where run_id = r.id and sc_share > 0
          order by sc_share desc, user_id limit 1;
        if v_top is not null then
          update payslips set sc_share = sc_share + (r.sc_pool - v_given) where run_id = r.id and user_id = v_top;
        end if;
      end if;
    end if;
  end if;
 
  select count(*) into v_open from shifts s join profiles pr on pr.id = s.user_id and pr.role <> 'owner'
    where s.ended_at is null and (s.started_at at time zone 'Indian/Maldives')::date between r.period_start and r.period_end;
  select count(*) into v_auto from shifts s join profiles pr on pr.id = s.user_id and pr.role <> 'owner'
    where coalesce(s.auto_closed, false) and (s.started_at at time zone 'Indian/Maldives')::date between r.period_start and r.period_end;
  select count(*) into v_missing from payslips ps join pay_profiles p on p.user_id = ps.user_id
    where ps.run_id = r.id and not ((p.pay_type = 'monthly' and p.basic_salary > 0) or (p.pay_type = 'hourly' and p.hourly_rate > 0));
 
  update pay_runs set sc_method = 'days', employer_name = st.employer_name,
      employer_address = st.employer_address, currency = st.currency, calculated_at = now()
    where id = r.id;
 
  return (select jsonb_build_object(
      'people', count(*), 'gross', coalesce(sum(gross), 0), 'net', coalesce(sum(net), 0),
      'sc_paid', coalesce(sum(sc_share), 0), 'open_shifts', v_open, 'auto_closed', v_auto,
      'pay_missing', v_missing)
    from payslips where run_id = r.id);
end $$;
 
revoke all on function public.payroll_calculate(uuid) from public, anon;
grant execute on function public.payroll_calculate(uuid) to authenticated;
 
