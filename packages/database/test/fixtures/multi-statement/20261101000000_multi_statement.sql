create table ledger_probe (
  id integer primary key,
  amount bigint not null check (amount >= 0)
);

insert into ledger_probe (id, amount) values (1, 100), (2, 250);

create index ledger_probe_amount_idx on ledger_probe (amount);

comment on table ledger_probe is 'semicolons; inside a string literal';

insert into ledger_probe (id, amount) values (3, 9007199254740993);
