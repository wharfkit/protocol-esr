import {Name, PublicKey, Struct, TimePointSec} from '@wharfkit/session'

@Struct.type('link_create')
export class LinkCreate extends Struct {
    @Struct.field('name') session_name!: Name
    @Struct.field('public_key') request_key!: PublicKey
    @Struct.field('string', {extension: true}) user_agent?: string
}

@Struct.type('link_info')
export class LinkInfo extends Struct {
    @Struct.field('time_point_sec') expiration!: TimePointSec
}
