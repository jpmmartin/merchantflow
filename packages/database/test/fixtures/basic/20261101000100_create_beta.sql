create table beta (
  id integer primary key,
  alpha_id integer not null references alpha (id)
);
