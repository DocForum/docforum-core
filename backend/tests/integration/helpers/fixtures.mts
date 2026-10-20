// Shared fixtures for the Phase-3 referral integration tests. Each test
// file still owns its own embedded Postgres + port + app instance (see
// booking.test.mts for the pattern); this module only bundles the HTTP
// flows every referral test repeats: signup, verify, promote, generate
// slots, book, complete, consult.
//
// Fixture-only direct DB writes (specialty links, doctor verification,
// role promotion, createdAt backdating) are deliberate: the APIs those
// stand in for are other issues' scope (#23 specialty management, admin
// bootstrap CLI) and are not what these tests are proving.
import request from 'supertest';

type App = ReturnType<typeof import('../../../src/app.js').createApp>;
type PrismaClient = typeof import('../../../src/db/prisma-client.js').prisma;

export interface DoctorFixture {
  userId: string;
  accessToken: string;
  profileId: string;
  email: string;
}

export interface PatientFixture {
  userId: string;
  accessToken: string;
  profileId: string;
  email: string;
}

let runCounter = 0;
function nextEmail(prefix: string, runId: number) {
  runCounter += 1;
  return `${prefix}-${runId}-${runCounter}@example.com`;
}

export async function installEmailCapture(emailedTokens: Map<string, string>) {
  const authServices = await import('../../../src/modules/auth/services/index.js');
  authServices.setEmailSender(async (message) => {
    const match = /[?&]token=([^&\s]+)/.exec(message.text);
    if (match) emailedTokens.set(message.to, decodeURIComponent(match[1]));
  });
}

export async function resetEmailSenderFixture() {
  const authServices = await import('../../../src/modules/auth/services/index.js');
  authServices.resetEmailSender();
}

async function signupAndVerify(
  app: App,
  emailedTokens: Map<string, string>,
  role: 'patient' | 'doctor',
  prefix: string,
  runId: number,
): Promise<{ userId: string; accessToken: string; email: string }> {
  const email = nextEmail(prefix, runId);
  const res = await request(app).post('/auth/signup').send({
    role,
    email,
    password: 'longenough123',
    fullName: `Fixture ${prefix}`,
  });
  if (res.status !== 200) throw new Error(`signup failed for ${email}: ${res.status} ${res.text}`);

  const token = emailedTokens.get(email);
  if (!token) throw new Error(`no verification email captured for ${email}`);
  const verified = await request(app).post('/auth/verify-email').send({ token });
  if (verified.status !== 200) throw new Error(`verify failed for ${email}`);

  return { userId: res.body.user.id as string, accessToken: res.body.accessToken as string, email };
}

/** Signup + verify + promote DoctorProfile to `verified` (+ optional
 * specialty assignment), since the manual-admin verification UI and
 * specialty management APIs are out of these tests' scope. */
export async function makeDoctor(
  app: App,
  prisma: PrismaClient,
  emailedTokens: Map<string, string>,
  runId: number,
  options: { specialtyId?: string } = {},
): Promise<DoctorFixture> {
  const base = await signupAndVerify(app, emailedTokens, 'doctor', 'doctor', runId);
  const profile = await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: base.userId } });
  await prisma.doctorProfile.update({
    where: { id: profile.id },
    data: { verificationStatus: 'verified' },
  });
  if (options.specialtyId) {
    await prisma.doctorSpecialty.create({
      data: { doctorProfileId: profile.id, specialtyId: options.specialtyId },
    });
  }
  return { ...base, profileId: profile.id };
}

export async function makePatient(
  app: App,
  emailedTokens: Map<string, string>,
  runId: number,
): Promise<PatientFixture> {
  const base = await signupAndVerify(app, emailedTokens, 'patient', 'patient', runId);
  const profile = await prismaProfileFor(app, base.userId);
  return { ...base, profileId: profile };
}

async function prismaProfileFor(app: App, userId: string): Promise<string> {
  void app;
  const db = await import('../../../src/db/prisma-client.js');
  const profile = await db.prisma.patientProfile.findUniqueOrThrow({ where: { userId } });
  return profile.id;
}

/** Promote-then-login: the role claim is baked into the access token, so
 * a promoted admin needs a fresh login to actually act as one. */
export async function makeAdmin(
  app: App,
  prisma: PrismaClient,
  emailedTokens: Map<string, string>,
  runId: number,
): Promise<{ accessToken: string; userId: string }> {
  const base = await signupAndVerify(app, emailedTokens, 'patient', 'admin', runId);
  await prisma.user.update({ where: { id: base.userId }, data: { role: 'admin' } });
  const login = await request(app).post('/auth/login').send({ email: base.email, password: 'longenough123' });
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status} ${login.text}`);
  return { userId: base.userId, accessToken: login.body.accessToken as string };
}

export async function makeSpecialty(prisma: PrismaClient, name: string): Promise<string> {
  const slug = name.toLowerCase().replace(/\s+/g, '-');
  const specialty = await prisma.specialty.create({ data: { name, slug } });
  return specialty.id;
}

/** Generate tomorrow-morning slots for a doctor and return their OPEN
 * ids. Wide window (08:00–20:00, 30-min slots → 24/day) on purpose: the
 * booking API's listing only returns still-open slots, and several tests
 * in one file consume slots of the same doctor on the same day. */
export async function generateSlots(
  app: App,
  doctor: { accessToken: string; profileId: string },
  _count = 6,
): Promise<string[]> {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const res = await request(app)
    .post(`/availability/doctors/${doctor.profileId}/slots/generate`)
    .set('Authorization', `Bearer ${doctor.accessToken}`)
    .send({ date: tomorrow, startHour: 8, endHour: 20, slotLengthMinutes: 30 });
  if (res.status !== 201) throw new Error(`slot generation failed: ${res.status} ${res.text}`);

  const slots = await request(app).get(`/availability/doctors/${doctor.profileId}/slots`);
  const ids = slots.body.map((slot: { id: string }) => slot.id);
  if (ids.length === 0) throw new Error(`no open slots for doctor ${doctor.profileId}`);
  return ids;
}

export async function bookAppointment(
  app: App,
  patient: { accessToken: string },
  slotId: string,
): Promise<{ id: string }> {
  const res = await request(app)
    .post('/appointments')
    .set('Authorization', `Bearer ${patient.accessToken}`)
    .send({ availabilitySlotId: slotId });
  if (res.status !== 201) throw new Error(`booking failed: ${res.status} ${res.text}`);
  return res.body as { id: string };
}

export async function setAppointmentStatus(
  app: App,
  doctor: { accessToken: string },
  appointmentId: string,
  status: 'completed' | 'cancelled' | 'no_show',
) {
  return request(app)
    .patch(`/appointments/${appointmentId}/status`)
    .set('Authorization', `Bearer ${doctor.accessToken}`)
    .send({ status });
}

export async function createConsultation(
  app: App,
  doctor: { accessToken: string },
  appointmentId: string,
  outcome: 'resolved' | 'referred' | 'follow_up_needed' = 'referred',
): Promise<{ id: string }> {
  const res = await request(app)
    .post('/consultations')
    .set('Authorization', `Bearer ${doctor.accessToken}`)
    .send({ appointmentId, outcome, notes: 'fixture consultation' });
  if (res.status !== 201) throw new Error(`consultation failed: ${res.status} ${res.text}`);
  return res.body as { id: string };
}

/** The end-to-end pre-referral ritual: slots, book, complete, consult. */
export async function consultationRitual(
  app: App,
  patient: PatientFixture,
  doctor: DoctorFixture,
): Promise<{ appointmentId: string; consultationId: string; slotId: string }> {
  const slots = await generateSlots(app, doctor, 2);
  const slotId = slots[0];
  const appointment = await bookAppointment(app, patient, slotId);
  const completed = await setAppointmentStatus(app, doctor, appointment.id, 'completed');
  if (completed.status !== 200) throw new Error(`complete failed: ${completed.status} ${completed.text}`);
  const consultation = await createConsultation(app, doctor, appointment.id);
  return { appointmentId: appointment.id, consultationId: consultation.id, slotId };
}

export async function createReferral(
  app: App,
  doctor: { accessToken: string },
  input: { sourceConsultationId: string; targetDoctorId: string; targetSpecialtyId?: string; snapshotNotes: string },
) {
  return request(app).post('/referrals').set('Authorization', `Bearer ${doctor.accessToken}`).send(input);
}

export async function acceptReferral(
  app: App,
  patient: { accessToken: string },
  referralId: string,
  availabilitySlotId: string,
) {
  return request(app)
    .post(`/referrals/${referralId}/accept`)
    .set('Authorization', `Bearer ${patient.accessToken}`)
    .send({ availabilitySlotId });
}
