INSERT INTO legal_documents (kind, version, content_sha256, url, display_text) VALUES
 ('terms','2026-10',sha256('r'::bytea),'/regulamin',NULL), ('privacy','2026-10',sha256('p'::bytea),'/prywatnosc',NULL),
 ('whatsapp','2026-10',sha256('w'::bytea),'/prywatnosc#whatsapp','Chcę otrzymać potwierdzenie i przypomnienie o wizycie na WhatsApp od Opony Mokotów. Mogę zrezygnować w każdej chwili, odpisując STOP.');
CREATE TEMP TABLE c(n int, name text, phone text, plate text, make text, model text, tire text);
INSERT INTO c VALUES
 (1,'Anna Kowalska','+48600100201','WX4521K','Skoda','Fabia','185/60 R15'),
 (2,'Piotr Nowak','+48600100202','WI73215','Toyota','Corolla',NULL),
 (3,'Katarzyna Zielińska','+48600100203','WPI8812C','Volkswagen','Golf','205/55 R16'),
 (4,'Tomasz Wójcik','+48600100204','WZ55104','Ford','Focus',NULL),
 (5,'Magdalena Lewandowska','+48600100205','WGM3A21','Kia','Ceed',NULL),
 (6,'Andrzej Kamiński','+48600100206','WX9930H','Opel','Astra','195/65 R15'),
 (7,'Ewa Dąbrowska','+48600100207','WE612KP','Renault','Clio',NULL),
 (8,'Michał Szymański','+48600100208','WOT44129','Hyundai','i30',NULL);
INSERT INTO customers (phone_e164, full_name) SELECT phone, name FROM c;
INSERT INTO vehicles (customer_id, make, model, registration_number, tire_size)
  SELECT cu.id, c.make, c.model, c.plate, c.tire FROM c JOIN customers cu ON cu.phone_e164 = c.phone;
CREATE TEMP TABLE ap(n int, d int, t time, dur int, st int, svc int, src appointment_source, status appointment_status);
INSERT INTO ap VALUES
 (1,1,'08:00',15,1,1,'online','confirmed'), (2,1,'08:00',15,2,1,'phone','confirmed'), (3,1,'08:30',30,1,2,'online','confirmed'),
 (4,1,'09:00',60,1,5,'phone','confirmed'), (5,1,'10:15',15,2,1,'online','confirmed'), (6,1,'11:00',15,1,1,'online','confirmed'),
 (7,1,'11:00',30,2,3,'walk_in','confirmed'), (8,1,'13:00',30,1,4,'online','confirmed'),
 (1,0,'08:00',15,1,1,'online','completed'), (3,0,'09:00',30,2,2,'phone','no_show'), (4,0,'10:00',15,1,1,'online','completed'),
 (6,2,'09:30',15,1,1,'online','confirmed'), (7,2,'12:00',60,2,5,'phone','confirmed'), (2,3,'08:15',15,1,1,'online','confirmed'),
 (5,4,'16:00',30,2,3,'online','confirmed');
INSERT INTO appointments (reference_code, customer_id, vehicle_id, service_id, station_id, starts_at, ends_at, source, status,
                          service_name_snapshot, created_by_admin_id)
SELECT upper(substr(md5(random()::text),1,8)), cu.id, v.id, ap.svc, ap.st,
       ((now() AT TIME ZONE 'Europe/Warsaw')::date + ap.d + ap.t) AT TIME ZONE 'Europe/Warsaw',
       ((now() AT TIME ZONE 'Europe/Warsaw')::date + ap.d + ap.t + make_interval(mins => ap.dur)) AT TIME ZONE 'Europe/Warsaw',
       ap.src, ap.status, s.name, CASE WHEN ap.src <> 'online' THEN (SELECT id FROM admins WHERE role='owner') END
  FROM ap JOIN c ON c.n = ap.n JOIN customers cu ON cu.phone_e164 = c.phone JOIN vehicles v ON v.customer_id = cu.id JOIN services s ON s.id = ap.svc;
UPDATE appointments SET reference_code = translate(reference_code, '01', 'AB');
INSERT INTO station_blocks (station_id, during, reason) VALUES
 (2, tstzrange((((now() AT TIME ZONE 'Europe/Warsaw')::date + 1 + time '14:00') AT TIME ZONE 'Europe/Warsaw'),
               (((now() AT TIME ZONE 'Europe/Warsaw')::date + 1 + time '16:00') AT TIME ZONE 'Europe/Warsaw')), 'Serwis podnośnika');
INSERT INTO customer_consents (customer_id, document_id) SELECT cu.id, d.id FROM customers cu, legal_documents d WHERE d.kind='whatsapp' AND cu.phone_e164 IN ('+48600100201','+48600100203');
INSERT INTO notifications (appointment_id, kind, channel, recipient_e164, scheduled_for, status, sent_at, delivered_at, read_at)
SELECT a.id, 'confirmation', 'whatsapp', '+48600100201', now() - interval '1 day', 'read', now() - interval '1 day', now() - interval '1 day', now() - interval '20 hours'
  FROM appointments a JOIN customers cu ON cu.id = a.customer_id WHERE cu.phone_e164 = '+48600100201' AND a.status = 'confirmed';
INSERT INTO notifications (appointment_id, kind, recipient_e164, scheduled_for)
SELECT a.id, 'reminder_24h', '+48600100201', a.starts_at - interval '24 hours'
  FROM appointments a JOIN customers cu ON cu.id = a.customer_id WHERE cu.phone_e164 = '+48600100201' AND a.status = 'confirmed';
UPDATE appointments SET admin_notes = 'Opony zimowe w przechowalni, regał B3' WHERE id = (SELECT a.id FROM appointments a JOIN customers cu ON cu.id=a.customer_id WHERE cu.phone_e164='+48600100206' AND a.starts_at > now() ORDER BY a.starts_at LIMIT 1);
