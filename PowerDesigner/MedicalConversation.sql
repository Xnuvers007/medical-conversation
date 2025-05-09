/*==============================================================*/
/* DBMS name:      MySQL 5.0                                    */
/* Created on:     08/05/2025 07:19:19                          */
/*==============================================================*/


drop table if exists bookings;

drop table if exists doctors;

drop table if exists messages;

drop table if exists user_logs;

drop table if exists users;

/*==============================================================*/
/* Table: bookings                                              */
/*==============================================================*/
create table bookings
(
   id                   INTEGER not null,
   user_id              INTEGER,
   doctor_id            INTEGER,
   message              TEXT,
   created_at           DATETIME default CURRENT_TIMESTAMP,
   is_active            BOOLEAN default 1,
   primary key (id)
);

/*==============================================================*/
/* Table: doctors                                               */
/*==============================================================*/
create table doctors
(
   id                   INTEGER not null,
   name                 TEXT,
   specialization       TEXT,
   phone                TEXT,
   photo_url            TEXT,
   primary key (id)
);

/*==============================================================*/
/* Table: messages                                              */
/*==============================================================*/
create table messages
(
   id                   INTEGER not null,
   booking_id           INTEGER,
   sender               TEXT,
   message              TEXT,
   msg_id               TEXT,
   has_media            BOOLEAN,
   timestamp            DATETIME default CURRENT_TIMESTAMP,
   primary key (id)
);

/*==============================================================*/
/* Table: user_logs                                             */
/*==============================================================*/
create table user_logs
(
   id                   INTEGER not null,
   user_id              INTEGER,
   action               TEXT,
   timestamp            DATETIME default CURRENT_TIMESTAMP,
   primary key (id)
);

/*==============================================================*/
/* Table: users                                                 */
/*==============================================================*/
create table users
(
   id                   INTEGER not null,
   name                 TEXT,
   role                 TEXT,
   username             TEXT,
   password             TEXT,
   primary key (id)
);

alter table bookings add constraint FK_Reference_1 foreign key (user_id)
      references users (id);

alter table bookings add constraint FK_Reference_2 foreign key (doctor_id)
      references doctors (id);

alter table messages add constraint FK_Reference_3 foreign key (booking_id)
      references bookings (id);

alter table user_logs add constraint FK_Reference_4 foreign key (user_id)
      references users (id);

