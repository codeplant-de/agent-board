import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { SignedXml } from 'xml-crypto';

export interface SamlKeyPair {
  privateKey: string;
  /** PEM certificate. */
  certificate: string;
}

/** A self-signed certificate and its key, as an IdP would own. */
export function generateSamlKeyPair(): SamlKeyPair {
  const folder = mkdtempSync(path.join(tmpdir(), 'board-saml-'));
  try {
    const key = path.join(folder, 'key.pem');
    const cert = path.join(folder, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-subj',
        '/CN=fake-idp',
        '-days',
        '2',
      ],
      {
        stdio: 'ignore',
      },
    );
    return { privateKey: readFileSync(key, 'utf8'), certificate: readFileSync(cert, 'utf8') };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** The request id inside the AuthnRequest of an HTTP-Redirect sign-in URL. */
export function requestIdOf(redirectUrl: string): string {
  const encoded = new URL(redirectUrl).searchParams.get('SAMLRequest') ?? '';
  const xml = inflateRawSync(Buffer.from(encoded, 'base64')).toString('utf8');
  const id = /\bID="([^"]+)"/.exec(xml)?.[1];
  if (!id) throw new Error('no ID in the AuthnRequest');
  return id;
}

export interface FakeResponse {
  /** The request the response answers; null plays an IdP-initiated response. */
  inResponseTo: string | null;
  audience: string;
  acsUrl: string;
  nameId?: string;
  attributes?: Record<string, string>;
  /** Signs with this key instead of the IdP's own, to play a forged assertion. */
  signWith?: SamlKeyPair;
  unsigned?: boolean;
  notOnOrAfter?: Date;
}

const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function assertionXml(response: FakeResponse, idp: string): string {
  const now = new Date();
  const later = response.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000);
  const earlier = new Date(now.getTime() - 60_000);
  const inResponseTo = response.inResponseTo ? ` InResponseTo="${response.inResponseTo}"` : '';
  const attributes = Object.entries(response.attributes ?? {})
    .map(
      ([name, value]) =>
        `<saml:Attribute Name="${escape(name)}"><saml:AttributeValue>${escape(value)}</saml:AttributeValue></saml:Attribute>`,
    )
    .join('');
  return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_assertion${Math.random().toString(16).slice(2)}" Version="2.0" IssueInstant="${now.toISOString()}">
<saml:Issuer>${idp}</saml:Issuer>
<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${escape(response.nameId ?? 'alice')}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${later.toISOString()}" Recipient="${response.acsUrl}"${inResponseTo}/></saml:SubjectConfirmation></saml:Subject>
<saml:Conditions NotBefore="${earlier.toISOString()}" NotOnOrAfter="${later.toISOString()}"><saml:AudienceRestriction><saml:Audience>${escape(response.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>
<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="_session1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>
<saml:AttributeStatement>${attributes}</saml:AttributeStatement>
</saml:Assertion>`;
}

/** The IdP's answer, as the base64 the browser posts to the ACS. */
export function samlResponse(idp: SamlKeyPair, response: FakeResponse): string {
  const entityId = 'https://idp.example.test/saml';
  const inResponseTo = response.inResponseTo ? ` InResponseTo="${response.inResponseTo}"` : '';
  let assertion = assertionXml(response, entityId);
  if (!response.unsigned) {
    const signer = response.signWith ?? idp;
    const sig = new SignedXml({
      privateKey: signer.privateKey,
      publicCert: signer.certificate,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    });
    sig.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    sig.computeSignature(assertion, {
      location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' },
    });
    assertion = sig.getSignedXml();
  }
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response${Math.random().toString(16).slice(2)}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${response.acsUrl}"${inResponseTo}><saml:Issuer>${entityId}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}</samlp:Response>`;
  return Buffer.from(xml).toString('base64');
}
