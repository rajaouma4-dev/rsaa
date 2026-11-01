import datetime
import ipaddress
import os
import hashlib
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization

os.makedirs('backend/certs', exist_ok=True)

# Generate private key
key = rsa.generate_private_key(
    public_exponent=65537,
    key_size=2048,
)

# Subject & Issuer
subject = issuer = x509.Name([
    x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
    x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "California"),
    x509.NameAttribute(NameOID.LOCALITY_NAME, "San Francisco"),
    x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Nexa Chat"),
    x509.NameAttribute(NameOID.COMMON_NAME, "10.109.201.244"),
])

# SANs
alt_names = [
    x509.DNSName("localhost"),
    x509.DNSName("nexa.local"),
    x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
    x509.IPAddress(ipaddress.IPv4Address("10.0.2.2")),
    x509.IPAddress(ipaddress.IPv4Address("10.109.201.244")),
]

cert = (
    x509.CertificateBuilder()
    .subject_name(subject)
    .issuer_name(issuer)
    .public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1))
    .not_valid_after(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=3650)) # 10 years
    .add_extension(x509.SubjectAlternativeName(alt_names), critical=False)
    .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
    .sign(key, hashes.SHA256())
)

# Write private key PEM
key_path = 'backend/certs/server.key'
with open(key_path, 'wb') as f:
    f.write(key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ))

# Write cert PEM
cert_path = 'backend/certs/server.crt'
with open(cert_path, 'wb') as f:
    f.write(cert.public_bytes(serialization.Encoding.PEM))

# Calculate SHA-256 fingerprint of DER representation
der_bytes = cert.public_bytes(serialization.Encoding.DER)
sha256_fp = hashlib.sha256(der_bytes).hexdigest()

print(f"Generated {cert_path} and {key_path}")
print(f"SHA-256 Fingerprint: {sha256_fp}")
